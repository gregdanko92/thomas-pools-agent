import cron from 'node-cron'
import { listJobs, getJobTasks, nextStage, STAGE_ORDER } from '../integrations/jobtread'
import type { Task } from '../integrations/jobtread'
import { postMessageWithTs, postInThread, lookupUserByName } from '../integrations/slack'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'

const TZ = 'America/Los_Angeles'

const CHECKIN_STAGES = new Set(STAGE_ORDER.filter(s => s !== 'On Hold'))

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Returns the last weekday on or before the given date (YYYY-MM-DD).
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

function formatDateRange(tasks: Task[]): string | null {
  const dated = tasks.filter(t => t.startDate)
  if (dated.length === 0) return null
  const starts = dated.map(t => t.startDate!).sort()
  const ends = dated.map(t => t.endDate ?? t.startDate!).sort()
  const start = starts[0]
  const end = ends[ends.length - 1]
  return start === end ? start : `${start} – ${end}`
}

function displayName(jobName: string, location: { address: string | null } | null): string {
  return /^job\s/i.test(jobName) && location?.address ? location.address : jobName
}

function buildCheckinMessage(
  jobName: string,
  pmName: string,
  pmUserId: string | null,
  stage: string,
  dateRange: string | null,
  next: string | null,
  testMode: boolean,
  testTargetLabel: string,
): string {
  const pmRef = pmUserId && !testMode ? `<@${pmUserId}>` : pmName
  const dateNote = dateRange ? ` from ${dateRange}` : ''
  const nextNote = next ? ` Next up is ${next}.` : ''
  const body = `${pmRef}, for the *${jobName}* job you're currently at *${stage}*${dateNote}.${nextNote} Is everything on track and are we ready for the next stage?`
  return testMode ? `[TEST MODE — Intended Target: ${testTargetLabel}]\n${body}` : body
}

export async function runPmCheckin(): Promise<void> {
  const testMode = process.env.SLACK_TEST_MODE === 'true'
  const testChannelId = process.env.SLACK_TEST_CHANNEL_ID

  if (testMode && !testChannelId) {
    throw new Error('SLACK_TEST_MODE is true but SLACK_TEST_CHANNEL_ID is not set')
  }

  const pilotPm = process.env.PILOT_PM?.trim() || null
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
  const LOOKAHEAD_DAYS = 5
  const COOLDOWN_DAYS = 2
  const lookaheadCutoff = addDays(today, LOOKAHEAD_DAYS)

  // Fetch active jobs with stage and PM, then get tasks per job in parallel.
  // Filters tasks by end date instead of stage keywords — no keyword matching needed.
  const activeStages = STAGE_ORDER.filter(s => s !== 'On Hold')
  const jobs = await listJobs({ stages: activeStages })
  const jobsWithPm = jobs.filter(j => j.stage && j.pm && (!pilotPm || j.pm === pilotPm))

  type JobGroup = {
    jobId: string
    jobName: string
    jobStage: string
    jobPm: string
    jobLocation: { address: string | null } | null
    tasks: Task[]
    earliestEnd: string
  }

  const jobGroups = new Map<string, JobGroup>()

  await Promise.all(jobsWithPm.map(async job => {
    const tasks = await getJobTasks(job.id)
    const windowTasks = tasks.filter(t => t.endDate && t.endDate >= today && t.endDate <= lookaheadCutoff)
    if (windowTasks.length === 0) return
    const earliestEnd = windowTasks.map(t => t.endDate!).sort()[0]
    jobGroups.set(job.id, {
      jobId: job.id,
      jobName: job.name,
      jobStage: job.stage!,
      jobPm: job.pm!,
      jobLocation: job.location,
      tasks: windowTasks,
      earliestEnd,
    })
  }))

  // Fetch channel mappings for qualifying jobs in one query
  const { data: channelRows, error } = await supabase
    .from('project_channels')
    .select('jobtread_job_id, slack_channel_id')
    .in('jobtread_job_id', [...jobGroups.keys()])

  if (error) throw new Error(`Failed to fetch project_channels: ${error.message}`)

  const channelByJobId = new Map(
    (channelRows ?? []).map(r => [r.jobtread_job_id, r.slack_channel_id]),
  )

  const sent: string[] = []
  const nudged: string[] = []
  const skipped: string[] = []

  for (const group of jobGroups.values()) {
    const { jobId, jobName, jobStage, jobPm, jobLocation, tasks, earliestEnd } = group

    const channelId = channelByJobId.get(jobId)
    if (!channelId) {
      skipped.push(`${jobName} — no channel mapping`)
      continue
    }

    const targetChannel = testMode ? testChannelId! : channelId

    // Rule 4 — open thread handling: nudge if pending thread exists from a prior day
    const { data: pendingThread } = await supabase
      .from('pm_checkin_threads')
      .select('id, thread_ts, slack_channel_id, checkin_date')
      .eq('jobtread_job_id', jobId)
      .eq('status', 'pending')
      .eq('checkin_stage', jobStage)
      .order('checkin_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (pendingThread) {
      if (pendingThread.checkin_date === today) {
        skipped.push(`${jobName} — pending thread from today`)
        continue
      }
      const nudgeChannel = testMode ? testChannelId! : pendingThread.slack_channel_id
      const nudge = `Just following up — any update on the *${jobStage}* stage for *${displayName(jobName, jobLocation)}*?`
      await postInThread(nudgeChannel, pendingThread.thread_ts, nudge)
      nudged.push(jobName)
      continue
    }

    // Rule 2 — cooldown: skip if resolved recently, unless it's deadline eve
    const deadlineEve = isDeadlineEve(earliestEnd, today)

    if (!deadlineEve) {
      const cooldownDate = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000)
        .toLocaleDateString('en-CA', { timeZone: TZ })
      const { data: recentResolved } = await supabase
        .from('pm_checkin_threads')
        .select('id')
        .eq('jobtread_job_id', jobId)
        .in('status', ['confirmed', 'delayed'])
        .gte('checkin_date', cooldownDate)
        .limit(1)
        .maybeSingle()

      if (recentResolved) {
        skipped.push(`${jobName} — resolved within last ${COOLDOWN_DAYS} days`)
        continue
      }
    }

    // All rules passed — send a fresh check-in
    const pmUserId = testMode ? null : await lookupUserByName(jobPm)
    const next = nextStage(jobStage)
    const dateRange = formatDateRange(tasks)
    const name = displayName(jobName, jobLocation)
    const targetLabel = `${jobPm} in #${channelId}`

    const text = buildCheckinMessage(name, jobPm, pmUserId, jobStage, dateRange, next, testMode, targetLabel)
    const threadTs = await postMessageWithTs(targetChannel, text)

    await supabase.from('pm_checkin_threads').upsert({
      thread_ts: threadTs,
      slack_channel_id: targetChannel,
      jobtread_job_id: jobId,
      jobtread_job_name: name,
      pm_name: jobPm,
      pm_slack_user_id: pmUserId ?? '',
      checkin_stage: jobStage,
      conversation_history: [{ role: 'agent', content: text }],
      status: 'pending',
      checkin_date: today,
    }, { onConflict: 'thread_ts' })

    sent.push(jobName)
  }

  // Also process nudges for jobs with pending threads that aren't in the lookahead window
  // (jobs whose stage tasks are outside 5 days but still have unanswered threads)
  const { data: stalePending } = await supabase
    .from('pm_checkin_threads')
    .select('id, thread_ts, slack_channel_id, checkin_date, jobtread_job_id, jobtread_job_name, checkin_stage, pm_name')
    .eq('status', 'pending')
    .neq('checkin_date', today)

  for (const thread of stalePending ?? []) {
    if (pilotPm && thread.pm_name !== pilotPm) continue
    // Skip if we already nudged this job in the loop above
    if (nudged.includes(thread.jobtread_job_name)) continue
    const nudgeChannel = testMode ? testChannelId! : thread.slack_channel_id
    const nudge = `Just following up — any update on the *${thread.checkin_stage}* stage for *${thread.jobtread_job_name}*?`
    await postInThread(nudgeChannel, thread.thread_ts, nudge)
    nudged.push(thread.jobtread_job_name)
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'pm_checkin',
    details: { sent: sent.length, nudged: nudged.length, skipped: skipped.length, skippedJobs: skipped },
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
