import cron from 'node-cron'
import { listJobs } from '../integrations/jobtread'
import type { Job } from '../integrations/jobtread'
import { getApp } from '../integrations/slack'
import { withRetry } from '../lib/retry'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'

const TZ = 'America/Los_Angeles'

// Channels that are never job channels — skip during reconciliation
const SKIP_CHANNELS = new Set([
  'general', 'random', 'agent-errors', 'daily-report', 'daily-reports',
])

// Channel name format: [lastname]-[new-const|remodel|repairs|etc]
// Returns the last-name segment (before the first dash), or null if no dash present.
function lastNameFromChannel(channelName: string): string | null {
  const idx = channelName.indexOf('-')
  if (idx === -1) return null
  return channelName.slice(0, idx).toLowerCase()
}

// Returns the last word of the job name as a lowercase last-name hint.
// Returns null for "Job N" placeholder names that have no real customer name.
function lastNameFromJob(jobName: string): string | null {
  if (/^job\s+\d+$/i.test(jobName)) return null
  const parts = jobName.trim().split(/\s+/)
  return parts[parts.length - 1].toLowerCase()
}

// Requires the channels:read bot scope. Add it in the Slack app's OAuth settings
// and reinstall the app if this throws missing_scope.
async function listAllSlackChannels(): Promise<Array<{ id: string; name: string }>> {
  const channels: Array<{ id: string; name: string }> = []
  let cursor: string | undefined
  do {
    const res = await withRetry(() =>
      getApp().client.conversations.list({
        exclude_archived: true,
        types: 'public_channel',
        limit: 200,
        cursor,
      }),
    )
    for (const ch of (res.channels ?? []) as Array<{ id?: string; name?: string }>) {
      if (ch.id && ch.name) channels.push({ id: ch.id, name: ch.name })
    }
    cursor = (res.response_metadata?.next_cursor as string | undefined) || undefined
  } while (cursor)
  return channels
}

export async function runChannelSync(): Promise<void> {
  const { data: existingRows, error } = await supabase
    .from('project_channels')
    .select('slack_channel_id, jobtread_job_id')
  if (error) throw new Error(`channel-sync: fetch project_channels failed: ${error.message}`)

  const mappedChannelIds = new Set((existingRows ?? []).map(r => r.slack_channel_id as string))
  const mappedJobIds = new Set((existingRows ?? []).map(r => r.jobtread_job_id as string))

  const allChannels = await listAllSlackChannels()
  const unmapped = allChannels.filter(
    ch => !mappedChannelIds.has(ch.id) && !SKIP_CHANNELS.has(ch.name),
  )

  if (unmapped.length === 0) {
    await logRun({ inserted: 0, ambiguous: 0, unmatched: 0 })
    return
  }

  const allJobs = await listJobs()
  const candidateJobs = allJobs.filter(j => !mappedJobIds.has(j.id))

  // Index: lowercase last name → list of jobs with that last name
  const byLastName = new Map<string, Job[]>()
  for (const job of candidateJobs) {
    const ln = lastNameFromJob(job.name)
    if (!ln) continue
    const bucket = byLastName.get(ln) ?? []
    bucket.push(job)
    byLastName.set(ln, bucket)
  }

  const inserted: string[] = []
  const ambiguous: string[] = []
  const unmatched: string[] = []

  for (const ch of unmapped) {
    const hint = lastNameFromChannel(ch.name)
    if (!hint) { unmatched.push(ch.name); continue }

    const candidates = byLastName.get(hint) ?? []

    if (candidates.length === 0) { unmatched.push(ch.name); continue }

    if (candidates.length > 1) {
      // Multiple jobs share the same last name — skip to avoid a wrong mapping.
      ambiguous.push(`#${ch.name} → ${candidates.map(j => j.name).join(' / ')}`)
      continue
    }

    const job = candidates[0]
    const { error: insertErr } = await supabase
      .from('project_channels')
      .insert({ slack_channel_id: ch.id, slack_channel_name: ch.name, jobtread_job_id: job.id })

    if (insertErr) {
      // Duplicate key = another run already inserted this row; not an error.
      const isDuplicate = (insertErr as { code?: string }).code === '23505'
      if (!isDuplicate) {
        throw new Error(`channel-sync: insert failed for #${ch.name}: ${insertErr.message}`)
      }
    } else {
      // Join the channel so the bot can post PM check-in messages to it.
      await withRetry(() =>
        getApp().client.conversations.join({ channel: ch.id }),
      ).catch(err => {
        // already_in_channel is benign; surface any other join failure as a warning only
        const code = (err as { data?: { error?: string } }).data?.error
        if (code !== 'already_in_channel') {
          console.warn(`[channel-sync] conversations.join #${ch.name} failed:`, code ?? err)
        }
      })
      inserted.push(`#${ch.name} → ${job.name} (${job.id})`)
    }
  }

  await logRun({
    inserted: inserted.length,
    ambiguous: ambiguous.length,
    unmatched: unmatched.length,
    insertedItems: inserted,
    ambiguousItems: ambiguous,
    unmatchedItems: unmatched,
  })
}

async function logRun(details: object): Promise<void> {
  await supabase
    .from('agent_run_log')
    .insert({ run_type: 'channel_sync', details, success: true })
    .then(() => undefined, () => undefined)
}

// Fires daily at 6 AM PT
export function startChannelSync(): void {
  cron.schedule('0 6 * * *', () => {
    withLock('channel-sync', () => runChannelSync()).catch(async err => {
      console.error('[channel-sync]', err instanceof Error ? err.message : err)
      await postErrorAlert('channel-sync', err)
    })
  }, { timezone: TZ })
}
