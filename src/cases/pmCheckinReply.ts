import { getApp, postInThread } from '../integrations/slack'
import { createComment, completeTask } from '../integrations/jobtread'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { shiftJobGantt, shiftTaskGantt, shiftAllByDays } from './shiftGantt'

const SYSTEM_PROMPT = `You are an assistant managing construction project check-ins for Thomas Pools.
A project manager has replied to a status check-in about a specific task on a job.

Classify the reply as one of:
- "completed" — PM says the task is done/finished/complete (e.g. "that's done", "all finished", "we completed that", "it's done", "done!")
- "confirmed" — PM says the task is on track but not yet finished (e.g. "looks good", "on schedule", "no issues")
- "delayed_with_date" — PM indicates a delay and provides a new expected completion date or timeframe
- "delayed_no_date" — PM indicates a delay but has no new timeline yet
- "needs_clarification" — the reply is ambiguous and you need to ask a follow-up question
- "shift_all" — PM says to shift the entire project schedule by a number of days (e.g. "push everything back 5 days", "shift the whole schedule a week", "move everything 3 days")

Respond with a JSON object:
{
  "status": "completed" | "confirmed" | "delayed_with_date" | "delayed_no_date" | "needs_clarification" | "shift_all",
  "summary": "one sentence summary of the PM's response for the Jobtread comment",
  "followup": "follow-up question to ask in Slack thread if status is needs_clarification, otherwise null",
  "newDate": "YYYY-MM-DD of the new expected completion date if status is delayed_with_date, otherwise null",
  "shiftDays": <number of days to shift as a JSON integer (e.g. 5, not "5") if status is shift_all, otherwise null>
}`

// Upper bound on a single "shift everything" request, to guard against a misparsed reply
// (e.g. "a month" read as 300) rescheduling an entire job.
const MAX_SHIFT_ALL_DAYS = 60

interface ParsedReply {
  status: 'completed' | 'confirmed' | 'delayed_with_date' | 'delayed_no_date' | 'needs_clarification' | 'shift_all'
  summary: string
  followup: string | null
  newDate: string | null
  shiftDays: number | null
}

async function parseReply(
  pmReply: string,
  jobName: string,
  taskName: string,
  history: Array<{ role: string; content: string }>,
): Promise<ParsedReply> {
  const context = history
    .map(m => `${m.role === 'agent' ? 'Agent' : 'PM'}: ${m.content}`)
    .join('\n')

  const prompt = `Job: ${jobName}\nTask: ${taskName}\n\nConversation so far:\n${context}\n\nLatest PM reply: ${pmReply}\n\nClassify this reply.`

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
      shiftDays: null,
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

      const replyText = (msg.text as string | undefined) ?? ''
      if (!replyText.trim()) return
      const history = (thread.conversation_history ?? []) as Array<{ role: string; content: string }>

      const taskRef = thread.task_name ?? thread.checkin_stage
      const parsed = await parseReply(
        replyText,
        thread.jobtread_job_name,
        taskRef,
        history,
      )

      const updatedHistory = [
        ...history,
        { role: 'pm', content: replyText },
      ]

      // If the LLM classified as delayed_with_date but omitted the date, treat like
      // delayed_no_date — keep the thread open and ask for the date explicitly.
      // Without this, the thread silently closes with no PM-facing response.
      if (parsed.status === 'delayed_with_date' && !parsed.newDate) {
        parsed.status = 'delayed_no_date'
      }

      // The LLM may return shiftDays as a string ("5"); string math in addDays would
      // concatenate instead of add, so coerce and validate before anything uses it.
      if (parsed.status === 'shift_all') {
        const days = Number(parsed.shiftDays)
        if (!Number.isInteger(days) || days <= 0) {
          parsed.status = 'needs_clarification'
          parsed.followup = 'Got it — how many days should I shift the entire schedule?'
          parsed.shiftDays = null
        } else if (days > MAX_SHIFT_ALL_DAYS) {
          parsed.status = 'needs_clarification'
          parsed.followup = `That's more than ${MAX_SHIFT_ALL_DAYS} days — I can only shift the whole schedule up to ${MAX_SHIFT_ALL_DAYS} days at a time. How many days should I shift it?`
          parsed.shiftDays = null
        } else {
          parsed.shiftDays = days
        }
      }

      // Threads that need more info — keep open, ask follow-up, don't resolve yet
      const needsFollowup =
        (parsed.status === 'needs_clarification' && parsed.followup) ||
        parsed.status === 'delayed_no_date'

      if (needsFollowup) {
        const question = parsed.status === 'delayed_no_date'
          ? `Got it — what's the new target completion date for the *${taskRef}* task?`
          : parsed.followup!
        await postInThread(thread.slack_channel_id, threadTs, question)
        updatedHistory.push({ role: 'agent', content: question })

        // Write a Jobtread comment so there's an audit trail even before we have the date.
        if (parsed.status === 'delayed_no_date') {
          const note = `PM check-in (${thread.checkin_date}): ${parsed.summary} (awaiting reschedule date)`
          await createComment(thread.jobtread_job_id, note).catch(() => undefined)
        }

        await supabase.from('pm_checkin_threads').update({
          conversation_history: updatedHistory,
        }).eq('thread_ts', threadTs)
        return
      }

      // Resolved — log to Jobtread and update thread status
      const jobtreadNote = `PM check-in (${thread.checkin_date}): ${parsed.summary}`
      await createComment(thread.jobtread_job_id, jobtreadNote).catch(() => undefined)

      if (parsed.status === 'delayed_with_date' && parsed.newDate) {
        const shift = thread.jobtread_task_id
          ? await shiftTaskGantt(thread.jobtread_job_id, thread.jobtread_task_id, parsed.newDate).catch(() => null)
          : await shiftJobGantt(thread.jobtread_job_id, parsed.newDate, thread.checkin_stage).catch(() => null)
        let delayMsg: string
        if (shift && shift.deltaDays < 0) {
          // PM gave a date earlier than the current Gantt end — job is tracking ahead.
          // shiftJobGantt returns early for negative deltas, so no Gantt changes were made.
          delayMsg = `Got it — noted ahead of schedule. New expected completion: ${parsed.newDate}.`
        } else {
          const ganttNote = shift && shift.shiftedTasks > 0
            ? ` Shifted ${shift.shiftedTasks} Gantt task${shift.shiftedTasks !== 1 ? 's' : ''} by ${shift.deltaDays} day${shift.deltaDays !== 1 ? 's' : ''}.`
            : ''
          delayMsg = `Got it — new expected completion: ${parsed.newDate}.${ganttNote}`
        }
        await postInThread(thread.slack_channel_id, threadTs, delayMsg)
        updatedHistory.push({ role: 'agent', content: delayMsg })
      }

      if (parsed.status === 'shift_all' && parsed.shiftDays) {
        const days = parsed.shiftDays
        const dayLabel = `${days} day${days !== 1 ? 's' : ''}`
        let shiftMsg: string
        try {
          const shift = await shiftAllByDays(thread.jobtread_job_id, days)
          shiftMsg = shift.shiftedTasks > 0
            ? `Got it — shifted all ${shift.shiftedTasks} upcoming task${shift.shiftedTasks !== 1 ? 's' : ''} by ${dayLabel}.`
            : `Got it — but there are no upcoming tasks on the schedule to shift, so nothing was changed.`
        } catch (err) {
          await postErrorAlert('pm-checkin-shift-all', err)
          shiftMsg = `Sorry — I hit an error shifting the schedule by ${dayLabel}. Some tasks may not have moved; please check the schedule in Jobtread.`
        }
        await postInThread(thread.slack_channel_id, threadTs, shiftMsg)
        updatedHistory.push({ role: 'agent', content: shiftMsg })
      }

      if (parsed.status === 'completed') {
        let completedMsg: string
        if (thread.jobtread_task_id) {
          try {
            await completeTask(thread.jobtread_task_id)
            completedMsg = `Got it — marked *${taskRef}* as complete in Jobtread! ✅`
          } catch (err) {
            await postErrorAlert('pm-checkin-complete-task', err)
            completedMsg = `Got it — logged *${taskRef}* as complete. (Heads up: I couldn't update the Jobtread checkmark — please mark it manually.)`
          }
        } else {
          completedMsg = `Got it — logged *${taskRef}* as complete!`
        }
        await postInThread(thread.slack_channel_id, threadTs, completedMsg)
        updatedHistory.push({ role: 'agent', content: completedMsg })
      }


      if (parsed.status === 'confirmed') {
        const confirmMsg = `Got it, thanks! Logged *${taskRef}* as on track.`
        await postInThread(thread.slack_channel_id, threadTs, confirmMsg)
        updatedHistory.push({ role: 'agent', content: confirmMsg })
      }

      const threadStatus = parsed.status === 'completed' || parsed.status === 'confirmed'
        ? parsed.status
        : 'delayed'
      await supabase.from('pm_checkin_threads').update({
        status: threadStatus,
        conversation_history: updatedHistory,
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
