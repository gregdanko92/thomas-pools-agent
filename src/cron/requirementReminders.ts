import cron from 'node-cron'
import { getJobRequirementData } from '../integrations/jobtread'
import type { RequirementJob, RequirementTask } from '../integrations/jobtread'
import { postMessageWithTs, postInThread, lookupUserByName } from '../integrations/slack'
import { displayName } from '../lib/jobDisplay'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'
import { isStaging, cronsEnabled, canReadJob, testChannelId as getTestChannelId } from '../lib/env'
import {
  REQUIREMENTS,
  REQUIREMENT_INACTIVE_STATUSES,
  isAtOrPast,
  matchesRequirementTask,
} from '../lib/requirements'
import type { Requirement } from '../lib/requirements'

const TZ = 'America/Los_Angeles'

export type RequirementState = 'needs_scheduling' | 'scheduled' | 'completed'

export interface JobRequirementRow {
  id: string
  jobtread_job_id: string
  jobtread_job_name: string
  requirement_key: string
  state: RequirementState
  jobtread_task_id: string | null
  scheduled_date: string | null
  slack_channel_id: string | null
  thread_ts: string | null
  warning_thread_ts: string | null
  pm_name: string | null
  conversation_history: Array<{ role: string; content: string }>
  last_pinged_date: string | null
}

// The task on the job that stands for this requirement: the one stored on the row if it
// still exists, otherwise a hand-added task whose name matches closely. Tasks already
// claimed by another requirement on the same job are never reused.
export function findRequirementTask(
  requirement: Requirement,
  tasks: RequirementTask[],
  storedTaskId: string | null,
  claimedTaskIds: Set<string>,
): RequirementTask | null {
  if (storedTaskId) {
    const stored = tasks.find(t => t.id === storedTaskId)
    if (stored) return stored
  }
  return tasks.find(t => !claimedTaskIds.has(t.id) && matchesRequirementTask(t.name, requirement)) ?? null
}

export async function upsertRequirementRow(
  jobId: string,
  requirementKey: string,
  fields: Partial<Omit<JobRequirementRow, 'id' | 'jobtread_job_id' | 'requirement_key'>>,
): Promise<void> {
  const { error } = await supabase.from('job_requirements').upsert({
    jobtread_job_id: jobId,
    requirement_key: requirementKey,
    ...fields,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'jobtread_job_id,requirement_key' })
  if (error) throw new Error(`job_requirements upsert failed: ${error.message}`)
}

function withTestHeader(body: string, testMode: boolean, targetLabel: string): string {
  return testMode ? `[TEST MODE — Intended Target: ${targetLabel}]\n${body}` : body
}

export async function runRequirementReminders(): Promise<void> {
  // Staging reroutes every post to the test channel with an "intended target" header.
  const testMode = isStaging()
  const testChannelId = testMode ? getTestChannelId() : undefined
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })

  const { data: channelRows, error } = await supabase
    .from('project_channels')
    .select('jobtread_job_id, slack_channel_id')
  if (error) throw new Error(`Failed to fetch project_channels: ${error.message}`)

  const { data: existingRows, error: rowsError } = await supabase
    .from('job_requirements')
    .select('*')
  if (rowsError) throw new Error(`Failed to fetch job_requirements: ${rowsError.message}`)

  const rowByKey = new Map(
    ((existingRows ?? []) as JobRequirementRow[]).map(r => [`${r.jobtread_job_id}:${r.requirement_key}`, r]),
  )

  const pinged: string[] = []
  const warned: string[] = []
  const skipped: string[] = []

  for (const { jobtread_job_id: jobId, slack_channel_id: channelId } of channelRows ?? []) {
    // Staging: rows left over from a read-all run may point at real jobs.
    if (!canReadJob(jobId)) continue

    let job: RequirementJob
    try {
      job = await getJobRequirementData(jobId)
    } catch (err) {
      skipped.push(`${jobId} — fetch failed: ${err instanceof Error ? err.message : err}`)
      continue
    }

    if (job.stage && REQUIREMENT_INACTIVE_STATUSES.has(job.stage)) continue
    const applicable = REQUIREMENTS.filter(r => job.fieldValues.get(r.fieldId) === true && isAtOrPast(job.stage, r.remindFrom))
    if (applicable.length === 0) continue
    if (!job.pm) {
      skipped.push(`${job.name} — no PM set`)
      continue
    }

    const jobName = displayName(job.name, job.location)
    const targetChannel = testMode ? testChannelId! : channelId
    const pmUserId = testMode ? null : await lookupUserByName(job.pm)
    const pmRef = pmUserId ? `<@${pmUserId}>` : job.pm
    const targetLabel = `${job.pm} in #${channelId}`

    const claimedTaskIds = new Set(
      [...rowByKey.values()]
        .filter(r => r.jobtread_job_id === jobId && r.jobtread_task_id)
        .map(r => r.jobtread_task_id!),
    )

    for (const requirement of applicable) {
      const label = `${job.name} / ${requirement.taskName}`
      const row = rowByKey.get(`${jobId}:${requirement.key}`)
      if (row?.state === 'completed') continue

      const task = findRequirementTask(requirement, job.tasks, row?.jobtread_task_id ?? null, claimedTaskIds)
      if (task) claimedTaskIds.add(task.id)
      const taskFields = {
        jobtread_job_name: jobName,
        jobtread_task_id: task?.id ?? null,
        scheduled_date: task?.startDate ?? task?.endDate ?? null,
        pm_name: job.pm,
      }

      if (task?.progress === 1) {
        await upsertRequirementRow(jobId, requirement.key, { ...taskFields, state: 'completed' })
        continue
      }

      const history = row?.conversation_history ?? []
      const pingedToday = row?.last_pinged_date === today

      // At or past the due-by status and not complete: a new top-level warning, then a
      // daily follow-up in that warning's thread until the task is ticked off.
      if (isAtOrPast(job.stage, requirement.dueBy)) {
        const state: RequirementState = taskFields.scheduled_date ? 'scheduled' : 'needs_scheduling'
        if (!row?.warning_thread_ts) {
          const body = withTestHeader(
            `⚠️ ${pmRef}, *${jobName}* is in *${job.stage}* and *${requirement.taskName}* isn't marked complete. ` +
            `Has it been done? Reply "done" and I'll check it off in Jobtread, or reply with the date it's scheduled.`,
            testMode, targetLabel,
          )
          const ts = await postMessageWithTs(targetChannel, body)
          await upsertRequirementRow(jobId, requirement.key, {
            ...taskFields,
            state,
            slack_channel_id: targetChannel,
            warning_thread_ts: ts,
            conversation_history: [...history, { role: 'agent', content: body }],
            last_pinged_date: today,
          })
          warned.push(label)
        } else if (!pingedToday) {
          const body = `${pmRef}, following up — *${requirement.taskName}* for *${jobName}* still isn't marked complete. Has it been done?`
          await postInThread(targetChannel, row.warning_thread_ts, body)
          await upsertRequirementRow(jobId, requirement.key, {
            ...taskFields,
            state,
            conversation_history: [...history, { role: 'agent', content: body }],
            last_pinged_date: today,
          })
          warned.push(`${label} (follow-up)`)
        } else {
          skipped.push(`${label} — already pinged today`)
        }
        continue
      }

      // On the Gantt with a date: pmCheckin takes it from here once it's within 5 days.
      if (task && taskFields.scheduled_date) {
        await upsertRequirementRow(jobId, requirement.key, { ...taskFields, state: 'scheduled' })
        continue
      }

      // Needs scheduling: one thread per job and requirement, followed up daily.
      if (!row?.thread_ts) {
        const body = withTestHeader(
          `${pmRef}, *${jobName}* is in *${job.stage}* and needs a *${requirement.taskName}* ` +
          `(the job's ${requirement.fieldName} field is set to Yes). It has to be done before ${requirement.dueBy}. ` +
          `When is it scheduled? Reply here with the date and I'll put it on the Gantt.`,
          testMode, targetLabel,
        )
        const ts = await postMessageWithTs(targetChannel, body)
        await upsertRequirementRow(jobId, requirement.key, {
          ...taskFields,
          state: 'needs_scheduling',
          slack_channel_id: targetChannel,
          thread_ts: ts,
          conversation_history: [...history, { role: 'agent', content: body }],
          last_pinged_date: today,
        })
        pinged.push(label)
      } else if (!pingedToday) {
        const body = `${pmRef}, following up — when is the *${requirement.taskName}* scheduled for *${jobName}*? Reply with the date and I'll add it to the Gantt.`
        await postInThread(targetChannel, row.thread_ts, body)
        await upsertRequirementRow(jobId, requirement.key, {
          ...taskFields,
          state: 'needs_scheduling',
          conversation_history: [...history, { role: 'agent', content: body }],
          last_pinged_date: today,
        })
        pinged.push(`${label} (follow-up)`)
      } else {
        skipped.push(`${label} — already pinged today`)
      }
    }
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'requirement_reminders',
    details: { pinged, warned, skipped },
    success: true,
  }).then(() => undefined, () => undefined)
}

// Fires at 4 PM Mon–Fri
export function startRequirementReminders(): void {
  if (!cronsEnabled()) return
  cron.schedule('0 16 * * 1-5', () => {
    withLock('requirement-reminders', () => runRequirementReminders()).catch(async err => {
      console.error('[requirement-reminders]', err instanceof Error ? err.message : err)
      await postErrorAlert('requirement-reminders', err)
    })
  }, { timezone: TZ })
}
