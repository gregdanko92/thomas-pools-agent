import { getApp, postInThread } from '../integrations/slack'
import { createComment } from '../integrations/jobtread'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'

const SYSTEM_PROMPT = `You are an assistant managing construction project check-ins for Thomas Pools.
A project manager has replied to a status check-in about a job's current Gantt stage.

Classify the reply as one of:
- "confirmed" — PM says things are on track, no issues
- "delayed_with_date" — PM indicates a delay and provides a new expected date or timeframe
- "delayed_no_date" — PM indicates a delay but has no new timeline yet
- "needs_clarification" — the reply is ambiguous and you need to ask a follow-up question

Respond with a JSON object:
{
  "status": "confirmed" | "delayed_with_date" | "delayed_no_date" | "needs_clarification",
  "summary": "one sentence summary of the PM's response for the Jobtread comment",
  "followup": "follow-up question to ask in Slack thread if status is needs_clarification, otherwise null",
  "newDate": "YYYY-MM-DD of the new expected completion if status is delayed_with_date, otherwise null"
}`

interface ParsedReply {
  status: 'confirmed' | 'delayed_with_date' | 'delayed_no_date' | 'needs_clarification'
  summary: string
  followup: string | null
  newDate: string | null
}

async function parseReply(
  pmReply: string,
  jobName: string,
  stage: string,
  history: Array<{ role: string; content: string }>,
): Promise<ParsedReply> {
  const context = history
    .map(m => `${m.role === 'agent' ? 'Agent' : 'PM'}: ${m.content}`)
    .join('\n')

  const prompt = `Job: ${jobName}\nCurrent stage: ${stage}\n\nConversation so far:\n${context}\n\nLatest PM reply: ${pmReply}\n\nClassify this reply.`

  const raw = await complete(prompt, { system: SYSTEM_PROMPT })

  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON found')
    return JSON.parse(match[0]) as ParsedReply
  } catch {
    return {
      status: 'needs_clarification',
      summary: pmReply,
      followup: 'Could you clarify — is the current stage on track or is there a delay?',
      newDate: null,
    }
  }
}

export function registerPmCheckinReplyHandler(): void {
  // Listen for all messages; filter to thread replies on tracked threads
  getApp().event('message', async ({ event }) => {
    const msg = event as unknown as Record<string, unknown>

    // Only handle thread replies (has thread_ts, not a top-level message)
    const threadTs = msg.thread_ts as string | undefined
    if (!threadTs || msg.subtype) return

    // Ignore bot messages to prevent self-reply loops
    if (msg.bot_id) return

    try {
      // Check if this thread is a tracked PM check-in
      const { data: thread, error } = await supabase
        .from('pm_checkin_threads')
        .select('*')
        .eq('thread_ts', threadTs)
        .maybeSingle()

      if (error || !thread) return
      if (thread.status === 'confirmed' || thread.status === 'delayed') return

      const replyText = (msg.text as string | undefined) ?? ''
      if (!replyText.trim()) return

      const history = (thread.conversation_history ?? []) as Array<{ role: string; content: string }>

      const parsed = await parseReply(
        replyText,
        thread.jobtread_job_name,
        thread.checkin_stage,
        history,
      )

      const updatedHistory = [
        ...history,
        { role: 'pm', content: replyText },
      ]

      if (parsed.status === 'needs_clarification' && parsed.followup) {
        await postInThread(thread.slack_channel_id, threadTs, parsed.followup)
        updatedHistory.push({ role: 'agent', content: parsed.followup })

        await supabase.from('pm_checkin_threads').update({
          conversation_history: updatedHistory,
        }).eq('thread_ts', threadTs)
        return
      }

      // Resolved — log to Jobtread and update thread status
      const jobtreadNote = `PM check-in (${thread.checkin_date}): ${parsed.summary}`
      await createComment(thread.jobtread_job_id, jobtreadNote).catch(() => undefined)

      if (parsed.status === 'delayed_with_date' && parsed.newDate) {
        const delayMsg = `Got it — I've noted the delay in Jobtread. New expected completion: ${parsed.newDate}.`
        await postInThread(thread.slack_channel_id, threadTs, delayMsg)
        updatedHistory.push({ role: 'agent', content: delayMsg })
      } else if (parsed.status === 'delayed_no_date') {
        const delayMsg = `Got it — I've noted the delay in Jobtread. I'll follow up tomorrow for an updated timeline.`
        await postInThread(thread.slack_channel_id, threadTs, delayMsg)
        updatedHistory.push({ role: 'agent', content: delayMsg })
      }

      // For confirmed, append the summary to history.
      // For delayed paths, the acknowledgement was already appended above.
      const finalHistory = parsed.status === 'confirmed'
        ? [...updatedHistory, { role: 'agent', content: parsed.summary }]
        : updatedHistory

      await supabase.from('pm_checkin_threads').update({
        status: parsed.status === 'confirmed' ? 'confirmed' : 'delayed',
        conversation_history: finalHistory,
      }).eq('thread_ts', threadTs)

      await supabase.from('agent_run_log').insert({
        run_type: 'pm_checkin_reply',
        jobtread_job_id: thread.jobtread_job_id,
        details: { status: parsed.status, summary: parsed.summary },
        success: true,
      }).then(() => undefined, () => undefined)
    } catch (err) {
      await postErrorAlert('pm-checkin-reply', err)
    }
  })
}
