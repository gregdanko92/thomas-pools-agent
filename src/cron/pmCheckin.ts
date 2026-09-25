import cron from 'node-cron'
import { listJobs, getJobTasks, STAGE_ORDER } from '../integrations/jobtread'
import type { Task } from '../integrations/jobtread'
import { postMessageWithTs, postInThread, lookupUserByName } from '../integrations/slack'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'

const TZ = 'America/Los_Angeles'

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function lastWeekdayOnOrBefore(dateStr: string): string {
  const d = new Date(dateStr)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return d.toISOString().slice(0, 10)
}

function isDeadlineEve(endDate: string, today: string): boolean {
  const effectiveDeadline = lastWeekdayOnOrBefore(endDate)
  const d = new Date(effectiveDeadline)
  d.setUTCDate(d.getUTCDate() - 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return today === d.toISOString().slice(0, 10) || today === effectiveDeadline
}

function taskDateLabel(task: Task): string | null {
  if (task.startDate && task.endDate && task.startDate !== task.endDate) {
    return `${task.startDate} – ${task.endDate}`
  }
  if (task.endDate) return `due ${task.endDate}`
  return null
}

function displayName(jobName: string, location: { address: string | null } | null): string {
  return /^job\s/i.test(jobName) && location?.address ? location.address : jobName
}

function buildCheckinMessage(
  jobName: string,
  taskName: string,
  pmName: string,
  pmUserId: string | null,
  dateLabel: string | null,
  testMode: boolean,
  testTargetLabel: string,
): string {
  const pmRef = pmUserId && !testMode ? `<@${pmUserId}>` : pmName
  const dateNote = dateLabel ? ` is scheduled ${dateLabel}` : ''
  const body = `${pmRef}, for the *${jobName}* job, the task *${taskName}*${dateNote}. Is it on track?`
  return testMode ? `[TEST MODE — Intended Target: ${testTargetLabel}]\n${body}` : body
}

export async function runPmCheckin(): Promise<void> {
  const testMode = process.env.SLACK_TEST_MODE === 'true'
  const testChannelId = process.env.SLACK_TEST_CHANNEL_ID

  if (testMode && !testChannelId) {
    throw new Error('SLACK_TEST_MODE is true but SLACK_TEST_CHANNEL_ID is not set')
  }

  const pilotPms = process.env.PILOT_PM
    ? new Set(process.env.PILOT_PM.split(',').map(s => s.trim()).filter(Boolean))
    : null
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
  const LOOKAHEAD_DAYS = 5
  const COOLDOWN_DAYS = 2
  const lookaheadCutoff = addDays(today, LOOKAHEAD_DAYS)

  const activeStages = STAGE_ORDER.filter(s => s !== 'On Hold')
  const jobs = await listJobs({ stages: activeStages })
  const jobsWithPm = jobs.filter(j => j.stage && j.pm && (!pilotPms || pilotPms.has(j.pm)))

  // Fetch tasks per job in small batches to avoid Jobtread rate limiting
  const CONCURRENCY = 2
  const BATCH_DELAY_MS = 300
  const jobTaskPairs: Array<{ job: typeof jobsWithPm[0]; windowTasks: Task[] }> = []
  for (let i = 0; i < jobsWithPm.length; i += CONCURRENCY) {
    if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
    const batch = await Promise.all(jobsWithPm.slice(i, i + CONCURRENCY).map(async job => {
      const tasks = await getJobTasks(job.id)
      const windowTasks = tasks.filter(t => t.endDate && t.endDate >= today && t.endDate <= lookaheadCutoff)
      return { job, windowTasks }
    }))
    jobTaskPairs.push(...batch)
  }

  // Fetch channel mappings for qualifying jobs in one query
  const qualifyingJobIds = jobTaskPairs.filter(p => p.windowTasks.length > 0).map(p => p.job.id)
  const { data: channelRows, error } = await supabase
    .from('project_channels')
    .select('jobtread_job_id, slack_channel_id')
    .in('jobtread_job_id', qualifyingJobIds)

  if (error) throw new Error(`Failed to fetch project_channels: ${error.message}`)

  const channelByJobId = new Map(
    (channelRows ?? []).map(r => [r.jobtread_job_id, r.slack_channel_id]),
  )

  const sent: string[] = []
  const nudgedThreadTs = new Set<string>()
  const skipped: string[] = []

  for (const { job, windowTasks } of jobTaskPairs) {
    if (windowTasks.length === 0) continue

    const channelId = channelByJobId.get(job.id)
    if (!channelId) {
      skipped.push(`${job.name} — no channel mapping`)
      continue
    }

    const targetChannel = testMode ? testChannelId! : channelId
    const jobName = displayName(job.name, job.location)
    const pmUserId = testMode ? null : await lookupUserByName(job.pm!)

    for (const task of windowTasks) {
      // Rule 1 — open thread: nudge if pending thread exists for this task from a prior day
      const { data: pendingThread } = await supabase
        .from('pm_checkin_threads')
        .select('id, thread_ts, slack_channel_id, checkin_date')
        .eq('jobtread_task_id', task.id)
        .eq('status', 'pending')
        .order('checkin_date', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (pendingThread) {
        if (pendingThread.checkin_date === today) {
          skipped.push(`${job.name} / ${task.name} — pending thread from today`)
          continue
        }
        const nudgeChannel = testMode ? testChannelId! : pendingThread.slack_channel_id
        await postInThread(nudgeChannel, pendingThread.thread_ts, `Just following up — any update on the *${task.name}* task for *${jobName}*?`)
        nudgedThreadTs.add(pendingThread.thread_ts)
        continue
      }

      // Rule 2 — cooldown: skip if resolved recently, unless deadline eve
      const deadlineEve = isDeadlineEve(task.endDate!, today)

      if (!deadlineEve) {
        const cooldownDate = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000)
          .toLocaleDateString('en-CA', { timeZone: TZ })
        const { data: recentResolved } = await supabase
          .from('pm_checkin_threads')
          .select('id')
          .eq('jobtread_task_id', task.id)
          .in('status', ['confirmed', 'delayed'])
          .gte('checkin_date', cooldownDate)
          .limit(1)
          .maybeSingle()

        if (recentResolved) {
          skipped.push(`${job.name} / ${task.name} — resolved within last ${COOLDOWN_DAYS} days`)
          continue
        }
      }

      // All rules passed — send a fresh check-in for this task
      const dateLabel = taskDateLabel(task)
      const targetLabel = `${job.pm} in #${channelId}`
      const text = buildCheckinMessage(jobName, task.name, job.pm!, pmUserId, dateLabel, testMode, targetLabel)
      const threadTs = await postMessageWithTs(targetChannel, text)

      await supabase.from('pm_checkin_threads').upsert({
        thread_ts: threadTs,
        slack_channel_id: targetChannel,
        jobtread_job_id: job.id,
        jobtread_job_name: jobName,
        jobtread_task_id: task.id,
        task_name: task.name,
        pm_name: job.pm!,
        pm_slack_user_id: pmUserId ?? '',
        checkin_stage: job.stage!,
        conversation_history: [{ role: 'agent', content: text }],
        status: 'pending',
        checkin_date: today,
      }, { onConflict: 'thread_ts' })

      sent.push(`${job.name} / ${task.name}`)
    }
  }

  // Nudge stale pending threads not already handled above
  const { data: stalePending } = await supabase
    .from('pm_checkin_threads')
    .select('id, thread_ts, slack_channel_id, checkin_date, jobtread_job_name, task_name, checkin_stage, pm_name')
    .eq('status', 'pending')
    .neq('checkin_date', today)

  for (const thread of stalePending ?? []) {
    if (pilotPms && !pilotPms.has(thread.pm_name)) continue
    if (nudgedThreadTs.has(thread.thread_ts)) continue
    const nudgeChannel = testMode ? testChannelId! : thread.slack_channel_id
    const taskRef = thread.task_name ?? thread.checkin_stage
    const nudge = `Just following up — any update on the *${taskRef}* task for *${thread.jobtread_job_name}*?`
    await postInThread(nudgeChannel, thread.thread_ts, nudge)
    nudgedThreadTs.add(thread.thread_ts)
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'pm_checkin',
    details: { sent: sent.length, nudged: nudgedThreadTs.size, skipped: skipped.length, skippedJobs: skipped },
    success: true,
  }).then(() => undefined, () => undefined)
}

// Fires at 4 PM Mon–Fri
export function startPmCheckin(): void {
  cron.schedule('0 16 * * 1-5', () => {
    withLock('pm-checkin', () => runPmCheckin()).catch(async err => {
      console.error('[pm-checkin]', err instanceof Error ? err.message : err)
      await postErrorAlert('pm-checkin', err)
    })
  }, { timezone: TZ })
}
