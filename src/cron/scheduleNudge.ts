import cron from 'node-cron'
import { listJobs, getJobTasks } from '../integrations/jobtread'
import { postMessage, lookupUserByName } from '../integrations/slack'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'
import { displayName } from '../lib/jobDisplay'

const TZ = 'America/Los_Angeles'
const ACTIVE_STAGES = new Set([
  'Engineering / Permitting',
  'Excavation',
  'Steel',
  'Plumbing / Electric',
  'Gunnite',
  'Coping / Tile',
  'Hardscape / Landscape',
  'Fence & Gate',
  'Plaster',
])

export async function runScheduleNudge(): Promise<void> {
  const testMode = process.env.SLACK_TEST_MODE === 'true'
  const testChannelId = process.env.SLACK_TEST_CHANNEL_ID

  if (testMode && !testChannelId) {
    throw new Error('SLACK_TEST_MODE is true but SLACK_TEST_CHANNEL_ID is not set')
  }

  const { data: channelRows, error } = await supabase
    .from('project_channels')
    .select('jobtread_job_id, slack_channel_id')

  if (error) throw new Error(`Failed to fetch project_channels: ${error.message}`)

  const channelByJobId = new Map(
    (channelRows ?? []).map(r => [r.jobtread_job_id, r.slack_channel_id]),
  )

  const allJobs = await listJobs()

  const qualifying = allJobs.filter(j =>
    channelByJobId.has(j.id) && j.stage !== null && ACTIVE_STAGES.has(j.stage),
  )

  const nudgeRecipient = process.env.SCHEDULE_NUDGE_RECIPIENT ?? 'Reagan'
  let nudgeUserId: string | null = null
  try {
    nudgeUserId = await lookupUserByName(nudgeRecipient)
  } catch {
    // fall back to plain name; cron continues
  }
  const reaganRef = nudgeUserId && !testMode ? `<@${nudgeUserId}>` : nudgeRecipient

  const nudged: string[] = []
  const skipped: string[] = []

  const CONCURRENCY = 2
  const BATCH_DELAY_MS = 300

  for (let i = 0; i < qualifying.length; i += CONCURRENCY) {
    if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
    const batch = qualifying.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(job => getJobTasks(job.id)))

    for (let j = 0; j < batch.length; j++) {
      const job = batch[j]
      const result = results[j]

      if (result.status === 'rejected') {
        skipped.push(`${job.name} — fetch error: ${result.reason}`)
        continue
      }

      if (result.value.length > 0) {
        skipped.push(`${job.name} — has ${result.value.length} tasks`)
        continue
      }

      const channelId = channelByJobId.get(job.id)!
      const targetChannel = testMode ? testChannelId! : channelId
      const jobLabel = displayName(job.name, job.location)

      const body = `${reaganRef}, *${jobLabel}* doesn't have any tasks in Jobtread yet. Can you add a schedule for this job?`
      const text = testMode ? `[TEST MODE — Intended Target: Reagan in #${channelId}]\n${body}` : body

      try {
        await postMessage(targetChannel, text)
        nudged.push(job.name)
      } catch (err) {
        skipped.push(`${job.name} — post error: ${err}`)
      }
    }
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'schedule_nudge',
    details: { nudged: nudged.length, skipped: skipped.length, nudgedJobs: nudged, skippedJobs: skipped },
    success: true,
  }).then(() => undefined, () => undefined)
}

// Fires at 9 AM Mon–Fri
export function startScheduleNudge(): void {
  cron.schedule('0 9 * * 1-5', () => {
    withLock('schedule-nudge', () => runScheduleNudge()).catch(async err => {
      console.error('[schedule-nudge]', err instanceof Error ? err.message : err)
      await postErrorAlert('schedule-nudge', err)
    })
  }, { timezone: TZ })
}
