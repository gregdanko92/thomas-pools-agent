import cron from 'node-cron'
import { listJobs } from '../integrations/jobtread'
import { nextStage, STAGE_ORDER } from '../integrations/jobtread'
import { getJobTasks } from '../integrations/jobtread'
import type { Task } from '../integrations/jobtread'
import { postMessageWithTs, postInThread, lookupUserByName } from '../integrations/slack'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'

const TZ = 'America/Los_Angeles'

// Stages that get PM check-ins (excludes On Hold)
const CHECKIN_STAGES = STAGE_ORDER.filter(s => s !== 'On Hold')

// Stage name → keywords used to find matching tasks in Jobtread
const STAGE_TASK_KEYWORDS: Record<string, string[]> = {
  'Sold': ['permit', 'plan', 'engineering'],
  'Engineering / Permitting': ['permit', 'engineering'],
  'Excavation': ['excavat'],
  'Steel': ['steel'],
  'Plumbing / Electric': ['plumbing', 'electric'],
  'Gunnite': ['gunite', 'gunnite'],
  'Coping / Tile': ['coping', 'tile'],
  'Hardscape / Landscape': ['hardscape', 'landscape'],
  'Fence & Gate': ['fence', 'gate'],
  'Plaster': ['plaster'],
}

function findStageTasks(tasks: Task[], stage: string): Task[] {
  const keywords = STAGE_TASK_KEYWORDS[stage] ?? []
  if (keywords.length === 0) return []
  return tasks.filter(t =>
    keywords.some(kw => t.name.toLowerCase().includes(kw)),
  )
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

function displayName(job: { name: string; location: { address: string | null } | null }): string {
  return /^job\s/i.test(job.name) && job.location?.address
    ? job.location.address
    : job.name
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
  const testUserId = process.env.SLACK_TEST_USER_ID

  if (testMode && !testUserId) {
    throw new Error('SLACK_TEST_MODE is true but SLACK_TEST_USER_ID is not set')
  }

  const jobs = await listJobs({ stages: CHECKIN_STAGES })
  const jobsWithPm = jobs.filter(j => j.pm)

  // Fetch channel mappings for all relevant jobs in one query
  const jobIds = jobsWithPm.map(j => j.id)
  const { data: channelRows, error } = await supabase
    .from('project_channels')
    .select('jobtread_job_id, slack_channel_id, jobtread_job_name')
    .in('jobtread_job_id', jobIds)

  if (error) throw new Error(`Failed to fetch project_channels: ${error.message}`)

  const channelByJobId = new Map(
    (channelRows ?? []).map(r => [r.jobtread_job_id, r.slack_channel_id]),
  )

  // Gather tasks and PM user IDs for all channel-mapped jobs in parallel
  const enriched = await Promise.all(
    jobsWithPm.map(async job => {
      const channelId = channelByJobId.get(job.id)
      if (!channelId) return { job, channelId: null, tasks: [] as Task[], pmUserId: null as string | null }
      const [tasks, pmUserId] = await Promise.all([
        getJobTasks(job.id),
        testMode ? Promise.resolve(null) : lookupUserByName(job.pm!),
      ])
      return { job, channelId, tasks, pmUserId }
    }),
  )

  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })

  // Only check in when the stage end date is within this many calendar days
  const LOOKAHEAD_DAYS = 5
  // Don't re-check a job that was confirmed or delayed this many days ago
  const COOLDOWN_DAYS = 2

  const sent: string[] = []
  const nudged: string[] = []
  const skipped: string[] = []

  for (const { job, channelId, tasks, pmUserId } of enriched) {
    if (!channelId) {
      skipped.push(`${job.name} — no channel mapping`)
      continue
    }

    const pmName = job.pm!
    const stage = job.stage!
    const next = nextStage(stage)
    const targetChannel = testMode ? testUserId! : channelId

    // Rule 4 — open thread handling
    // Fetch the most recent pending thread for this job (any date)
    const { data: pendingThread } = await supabase
      .from('pm_checkin_threads')
      .select('id, thread_ts, slack_channel_id, checkin_date')
      .eq('jobtread_job_id', job.id)
      .eq('status', 'pending')
      .order('checkin_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (pendingThread) {
      if (pendingThread.checkin_date === today) {
        // Sent today and still unanswered — don't send again
        skipped.push(`${job.name} — pending thread from today`)
        continue
      }
      // Sent a previous day (24h+) with no reply — nudge in the existing thread
      const nudgeChannel = testMode ? testUserId! : pendingThread.slack_channel_id
      const nudge = `Just following up — any update on the *${stage}* stage for *${displayName(job)}*?`
      await postInThread(nudgeChannel, pendingThread.thread_ts, nudge)
      nudged.push(job.name)
      continue
    }

    // Rule 1 — lookahead window: only check in when a stage task ends within LOOKAHEAD_DAYS
    const stageTasks = findStageTasks(tasks, stage)
    const allStageDates = stageTasks
      .map(t => t.endDate ?? t.startDate)
      .filter((d): d is string => d != null)
      .sort()
    const earliestEnd = allStageDates[0]

    const daysUntilEnd = earliestEnd
      ? Math.ceil((new Date(earliestEnd).getTime() - Date.now()) / 86_400_000)
      : null

    if (daysUntilEnd !== null && daysUntilEnd > LOOKAHEAD_DAYS) {
      skipped.push(`${job.name} — stage ends in ${daysUntilEnd} days (outside ${LOOKAHEAD_DAYS}-day window)`)
      continue
    }

    // Rule 2 — cooldown: skip if confirmed or delayed within the last COOLDOWN_DAYS days.
    // Exception: always check in the day before the deadline regardless of cooldown.
    const isDeadlineEve = daysUntilEnd !== null && daysUntilEnd <= 1

    if (!isDeadlineEve) {
      const cooldownDate = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000)
        .toLocaleDateString('en-CA', { timeZone: TZ })
      const { data: recentResolved } = await supabase
        .from('pm_checkin_threads')
        .select('id')
        .eq('jobtread_job_id', job.id)
        .in('status', ['confirmed', 'delayed'])
        .gte('checkin_date', cooldownDate)
        .limit(1)
        .maybeSingle()

      if (recentResolved) {
        skipped.push(`${job.name} — resolved within last ${COOLDOWN_DAYS} days`)
        continue
      }
    }

    // All rules passed — send a fresh check-in
    const dateRange = formatDateRange(stageTasks)
    const targetLabel = `${pmName} in #${channelId}`

    const text = buildCheckinMessage(
      displayName(job),
      pmName,
      pmUserId,
      stage,
      dateRange,
      next,
      testMode,
      targetLabel,
    )

    const threadTs = await postMessageWithTs(targetChannel, text)

    await supabase.from('pm_checkin_threads').upsert({
      thread_ts: threadTs,
      slack_channel_id: targetChannel,
      jobtread_job_id: job.id,
      jobtread_job_name: displayName(job),
      pm_name: pmName,
      pm_slack_user_id: pmUserId ?? '',
      checkin_stage: stage,
      conversation_history: [{ role: 'agent', content: text }],
      status: 'pending',
      checkin_date: today,
    }, { onConflict: 'thread_ts' })

    sent.push(job.name)
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'pm_checkin',
    details: { sent: sent.length, nudged: nudged.length, skipped: skipped.length, skippedJobs: skipped },
    success: true,
  }).then(() => undefined, () => undefined)
}

// Fires at 4 PM Mon–Fri (cron expression already limits to weekdays).
export function startPmCheckin(): void {
  cron.schedule('0 16 * * 1-5', () => {
    withLock('pm-checkin', () => runPmCheckin()).catch(async err => {
      console.error('[pm-checkin]', err instanceof Error ? err.message : err)
      await postErrorAlert('pm-checkin', err)
    })
  }, { timezone: TZ })
}
