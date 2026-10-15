// Fires a cron on the deployed staging service.
// Usage: npm run staging:trigger -- <name>   e.g. pm-checkin, morning, evening, schedule-nudge
import './loadEnv'

const CRONS = ['morning', 'evening', 'vendor-outreach', 'calendar-sync', 'payment-reminders', 'pm-checkin', 'channel-sync', 'schedule-nudge']

async function main() {
  const name = process.argv[2]
  if (!name || !CRONS.includes(name)) {
    console.error(`Usage: npm run staging:trigger -- <${CRONS.join(' | ')}>`)
    process.exit(1)
  }
  const baseUrl = process.env.STAGING_URL?.replace(/\/$/, '')
  if (!baseUrl) throw new Error('STAGING_URL is not set in .env.staging')

  const res = await fetch(`${baseUrl}/cron/${name}`, {
    method: 'POST',
    headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' },
  })
  console.log(`${res.status} ${await res.text()}`)
  if (!res.ok) process.exit(1)
  console.log('Triggered — watch the test channel and the staging logs.')
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
