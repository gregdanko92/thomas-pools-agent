// Wipes the staging database and re-seeds the channel mapping for each allowlisted
// test job (mapped to SLACK_TEST_CHANNEL_ID). Usage: npm run staging:reset-db
import './loadEnv'
import { supabase } from '../../src/db/client'
import { getJob } from '../../src/integrations/jobtread'
import { getApp } from '../../src/integrations/slack'
import { allowedJobIds, testChannelId } from '../../src/lib/env'

// Child tables first (outreach_log references vendors).
const TABLES: Array<{ name: string; key: string }> = [
  { name: 'outreach_log', key: 'id' },
  { name: 'vendors', key: 'id' },
  { name: 'payment_schedules', key: 'id' },
  { name: 'agent_run_log', key: 'id' },
  { name: 'calendar_sync', key: 'id' },
  { name: 'pm_checkin_threads', key: 'id' },
  { name: 'project_channels', key: 'id' },
  { name: 'daily_reports', key: 'id' },
  { name: 'cron_locks', key: 'lock_name' },
]

async function main() {
  for (const { name, key } of TABLES) {
    // Supabase requires a filter on delete; "key is not null" matches every row.
    const { error, count } = await supabase.from(name).delete({ count: 'exact' }).not(key, 'is', null)
    if (error) throw new Error(`clear ${name} failed: ${error.message}`)
    console.log(`cleared ${name} (${count ?? 0} rows)`)
  }

  // slack_channel_id is unique, so only the first test job can map to the test channel.
  const [jobId] = allowedJobIds()
  const job = await getJob(jobId)
  const channel = testChannelId()
  const info = await getApp().client.conversations.info({ channel })
  const channelName = info.channel?.name ?? channel
  const { error } = await supabase.from('project_channels').insert({
    slack_channel_id: channel,
    slack_channel_name: channelName,
    jobtread_job_id: job.id,
    jobtread_job_name: job.name,
  })
  if (error) throw new Error(`seed project_channels failed: ${error.message}`)
  console.log(`seeded project_channels: ${job.name} (${job.id}) → #${channelName}`)
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
