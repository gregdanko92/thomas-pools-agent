import { getApp, postInThread } from '../integrations/slack'
import { getJobRequirementData, createTask, updateTask, completeTask } from '../integrations/jobtread'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { requirementByKey } from '../lib/requirements'
import { findRequirementTask, upsertRequirementRow } from '../cron/requirementReminders'
import type { JobRequirementRow } from '../cron/requirementReminders'

const TZ = 'America/Los_Angeles'

const SYSTEM_PROMPT = `You are an assistant tracking required inspections for Thomas Pools construction jobs.
The agent asked a project manager about a required inspection on a job, and the PM replied in the thread.

Classify the latest reply as one of:
- "scheduled_with_date" — the inspection is scheduled and the PM gives the date (e.g. "scheduled for the 22nd", "booked Tuesday", "10/30")
- "scheduled_no_date" — the PM says it's scheduled or being booked but gives no date
- "completed" — the inspection is already done or passed (e.g. "done", "passed yesterday", "inspector signed off")
- "not_yet" — not scheduled yet, no date, but the PM is working on it or will update later (e.g. "not yet", "waiting on the city")
- "not_needed" — the PM says this job doesn't need the inspection
- "unclear" — anything else; ask a short follow-up question

Today's date is given in the prompt. Resolve relative dates ("Tuesday", "the 22nd", "next week Thursday") to the next
matching date on or after today. Output dates as YYYY-MM-DD.

Respond with a JSON object:
{
  "status": "scheduled_with_date" | "scheduled_no_date" | "completed" | "not_yet" | "not_needed" | "unclear",
  "date": "YYYY-MM-DD if status is scheduled_with_date, otherwise null",
  "summary": "one sentence summary of the PM's reply",
  "followup": "short follow-up question if status is unclear, otherwise null"
}`

type ReplyStatus = 'scheduled_with_date' | 'scheduled_no_date' | 'completed' | 'not_yet' | 'not_needed' | 'unclear'

interface ParsedReply {
  status: ReplyStatus
  date: string | null
  summary: string
  followup: string | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function parseReply(
  reply: string,
  jobName: string,
  taskName: string,
  today: string,
  history: Array<{ role: string; content: string }>,
): Promise<ParsedReply> {
  const weekday = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' })
  const context = history
    .map(m => `${m.role === 'agent' ? 'Agent' : 'PM'}: ${m.content}`)
    .join('\n')
  const prompt = `Today: ${today} (${weekday})\nJob: ${jobName}\nInspection: ${taskName}\n\nConversation so far:\n${context}\n\nLatest PM reply: ${reply}\n\nClassify this reply.`

  const raw = await complete(prompt, { system: SYSTEM_PROMPT })
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON found')
    return JSON.parse(match[0]) as ParsedReply
  } catch {
    return { status: 'unclear', date: null, summary: reply, followup: null }
  }
}

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
}

export function registerRequirementReplyHandler(): void {
  getApp().event('message', async ({ event }) => {
    const msg = event as unknown as Record<string, unknown>
    const threadTs = msg.thread_ts as string | undefined
    if (!threadTs || msg.subtype || msg.bot_id) return

    try {
      // Only threads this feature started: the needs-scheduling thread or the due-by warning.
      const { data, error } = await supabase
        .from('job_requirements')
        .select('*')
        .or(`thread_ts.eq."${threadTs}",warning_thread_ts.eq."${threadTs}"`)
        .limit(1)
        .maybeSingle()
      if (error || !data) return
      const row = data as JobRequirementRow
      if (row.state === 'completed') return

      const requirement = requirementByKey(row.requirement_key)
      if (!requirement) return

      const replyText = ((msg.text as string | undefined) ?? '').trim()
      if (!replyText) return

      const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
      const history = row.conversation_history ?? []
      const parsed = await parseReply(replyText, row.jobtread_job_name, requirement.taskName, today, history)
      if (parsed.status === 'scheduled_with_date' && !(parsed.date && DATE_RE.test(parsed.date))) {
        parsed.status = 'scheduled_no_date'
      }

      const taskName = requirement.taskName
      const channel = row.slack_channel_id!
      const updates: Parameters<typeof upsertRequirementRow>[2] = {}
      let response: string

      if (parsed.status === 'scheduled_with_date' || parsed.status === 'completed') {
        const job = await getJobRequirementData(row.jobtread_job_id)
        const { data: siblings } = await supabase
          .from('job_requirements')
          .select('jobtread_task_id')
          .eq('jobtread_job_id', row.jobtread_job_id)
          .neq('requirement_key', row.requirement_key)
        const claimed = new Set((siblings ?? []).map(s => s.jobtread_task_id).filter((id): id is string => !!id))
        const existing = findRequirementTask(requirement, job.tasks, row.jobtread_task_id, claimed)

        if (parsed.status === 'scheduled_with_date') {
          const date = parsed.date!
          let taskId: string
          try {
            if (existing) {
              await updateTask(existing.id, { startDate: date, endDate: date })
              taskId = existing.id
            } else {
              taskId = (await createTask(row.jobtread_job_id, { name: taskName, startDate: date, endDate: date })).id
            }
            Object.assign(updates, { state: 'scheduled', jobtread_task_id: taskId, scheduled_date: date })
            response = `Got it — *${taskName}* is on the Gantt for ${formatDate(date)}. I'll check in as it gets close.`
          } catch (err) {
            await postErrorAlert('requirement-reply-schedule', err)
            response = `Got it — ${formatDate(date)}. (Heads up: I couldn't put *${taskName}* on the Gantt — please add it in Jobtread.)`
          }
        } else {
          // Already done: tick the existing task, or add one dated today and tick that.
          try {
            const taskId = existing?.id
              ?? (await createTask(row.jobtread_job_id, { name: taskName, startDate: today, endDate: today })).id
            await completeTask(taskId)
            Object.assign(updates, {
              state: 'completed',
              jobtread_task_id: taskId,
              scheduled_date: existing ? (existing.startDate ?? existing.endDate) : today,
            })
            response = `Got it — marked *${taskName}* complete in Jobtread! ✅`
          } catch (err) {
            await postErrorAlert('requirement-reply-complete', err)
            response = `Got it — logged *${taskName}* as done. (Heads up: I couldn't update Jobtread — please mark it complete there.)`
          }
        }
      } else if (parsed.status === 'scheduled_no_date') {
        response = `Great — what date is the *${taskName}* scheduled for? I'll put it on the Gantt.`
      } else if (parsed.status === 'not_yet') {
        response = `Got it — I'll check back tomorrow on the *${taskName}*.`
      } else if (parsed.status === 'not_needed') {
        response = `Got it. The job's *${requirement.fieldName}* field is set to Yes in Jobtread, so I'll keep asking about the *${taskName}*. If it isn't needed, please set ${requirement.fieldName} to No.`
      } else {
        response = parsed.followup?.trim() || `Sorry, I didn't catch that — is the *${taskName}* scheduled? If so, what's the date?`
      }

      await postInThread(channel, threadTs, response)
      await upsertRequirementRow(row.jobtread_job_id, row.requirement_key, {
        ...updates,
        conversation_history: [...history, { role: 'pm', content: replyText }, { role: 'agent', content: response }],
      })

      await supabase.from('agent_run_log').insert({
        run_type: 'requirement_reply',
        jobtread_job_id: row.jobtread_job_id,
        details: { requirement: row.requirement_key, status: parsed.status, date: parsed.date, summary: parsed.summary },
        success: true,
      }).then(() => undefined, () => undefined)
    } catch (err) {
      await postErrorAlert('requirement-reply', err)
    }
  })
}
