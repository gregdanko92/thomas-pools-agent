import cron from 'node-cron'
import { listJobs, getJob } from '../integrations/jobtread'
import { nextStage, STAGE_ORDER } from '../integrations/jobtread'
import type { JobDetail } from '../integrations/jobtread'
import { postMessage } from '../integrations/slack'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'

const ACTIVE_STAGES = STAGE_ORDER.filter(s => s !== 'On Hold')
const TZ = 'America/Los_Angeles'

const SYSTEM_PROMPT = `You are a morning briefing assistant for Thomas Pools, a pool construction company.
You will receive Gantt status data for all active jobs including PM check-in responses from yesterday afternoon.
Produce a concise leadership summary for Aaron and Mark.
Use Slack formatting: wrap each job name in *asterisks* to make it bold. No other markdown — no headers, no bullet symbols, no dashes.

For each job include: current stage, projected dates if known, next stage, and PM response status.
Flag: jobs where PM did not respond, jobs with active delays, outstanding invoices over $0, jobs missing a PM, jobs with no Slack channel mapped.
Skip jobs with no notable status.
End with: "Total active jobs: N" and "Jobs needing attention: M".`

interface CheckinStatus {
  status: string
  summary: string
}

async function fetchCheckinStatuses(jobIds: string[]): Promise<Map<string, CheckinStatus>> {
  // Use PT dates — check-ins are stored with PT-local dates from pmCheckin.ts
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: TZ })

  const { data } = await supabase
    .from('pm_checkin_threads')
    .select('jobtread_job_id, status, conversation_history, checkin_date')
    .in('jobtread_job_id', jobIds)
    .in('checkin_date', [today, yesterday])
    .order('created_at', { ascending: false })

  const map = new Map<string, CheckinStatus>()
  for (const row of data ?? []) {
    if (map.has(row.jobtread_job_id)) continue
    const history = (row.conversation_history ?? []) as Array<{ role: string; content: string }>
    const lastPmMsg = [...history].reverse().find(m => m.role === 'pm')
    map.set(row.jobtread_job_id, {
      status: row.status,
      summary: lastPmMsg?.content ?? '(no reply)',
    })
  }
  return map
}

async function fetchUnmappedJobs(jobIds: string[]): Promise<Set<string>> {
  const { data } = await supabase
    .from('project_channels')
    .select('jobtread_job_id')
    .in('jobtread_job_id', jobIds)

  const mapped = new Set((data ?? []).map(r => r.jobtread_job_id))
  return new Set(jobIds.filter(id => !mapped.has(id)))
}

function buildPrompt(jobs: JobDetail[], checkins: Map<string, CheckinStatus>, unmapped: Set<string>, totalActive: number): string {
  const headerDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: TZ,
  })

  const lines: string[] = [
    `Morning Gantt status report — ${headerDate}`,
    `Total active jobs: ${totalActive}.`,
    '',
  ]

  for (const job of jobs) {
    const name = /^job\s/i.test(job.name) && job.location?.address
      ? job.location.address
      : job.name

    lines.push(`JOB: ${name}`)
    lines.push(`Stage: ${job.stage ?? job.status} | PM: ${job.pm ?? 'UNASSIGNED'} | Next: ${job.stage ? (nextStage(job.stage) ?? 'Final') : 'unknown'}`)

    if (unmapped.has(job.id)) lines.push('WARNING: No Slack channel mapped')

    const checkin = checkins.get(job.id)
    if (checkin) {
      lines.push(`PM check-in: ${checkin.status} — ${checkin.summary}`)
    } else {
      lines.push('PM check-in: no response')
    }

    const pendingInvoices = job.documents.filter(
      d => (d.type === 'invoice' || d.type === 'Invoice') && d.status !== 'paid',
    )
    for (const inv of pendingInvoices) {
      const amount = inv.price !== null ? ` $${inv.price.toLocaleString()}` : ''
      lines.push(`Outstanding invoice: ${inv.name}${amount} [${inv.status}]`)
    }

    lines.push('')
  }

  return `Produce a focused morning Gantt status report for leadership:\n\n${lines.join('\n')}`
}

export async function runMorningHealthCheck(): Promise<void> {
  let channel = ''
  let totalActive = 0

  try {
    const id = process.env.SLACK_MORNING_CHANNEL
    if (!id) throw new Error('SLACK_MORNING_CHANNEL is not set')
    channel = id

    const activeJobs = await listJobs({ stages: ACTIVE_STAGES })
    totalActive = activeJobs.length

    if (activeJobs.length === 0) {
      await postMessage(channel, 'No active jobs this morning — nothing to report.')
      return
    }

    const results = await Promise.allSettled(activeJobs.map(j => getJob(j.id)))
    const details = results
      .filter((r): r is PromiseFulfilledResult<JobDetail> => r.status === 'fulfilled')
      .map(r => r.value)

    if (details.length === 0) throw new Error('All getJob calls failed — no data to report')

    const jobIds = details.map(j => j.id)
    const [checkins, unmapped] = await Promise.all([
      fetchCheckinStatuses(jobIds),
      fetchUnmappedJobs(jobIds),
    ])

    const summary = await complete(buildPrompt(details, checkins, unmapped, totalActive), { system: SYSTEM_PROMPT })

    await postMessage(channel, summary)

    await Promise.allSettled([
      supabase.from('daily_reports').insert({
        report_type: 'morning',
        slack_channel: channel,
        content: summary,
      }),
      supabase.from('agent_run_log').insert({
        run_type: 'morning_check',
        details: { totalActive, detailsFetched: details.length },
        success: true,
      }),
    ])
  } catch (err) {
    await supabase.from('agent_run_log').insert({
      run_type: 'morning_check',
      details: { totalActive },
      success: false,
      error_message: err instanceof Error ? err.message : String(err),
    }).then(() => undefined, () => undefined)

    throw err
  }
}

// Fires daily at 7 AM America/Los_Angeles — construction crews work weekends.
export function startMorningHealthCheck(): void {
  cron.schedule('0 7 * * *', () => {
    withLock('morning-health-check', () => runMorningHealthCheck()).catch(async err => {
      console.error('[morning-health-check]', err instanceof Error ? err.message : err)
      await postErrorAlert('morning-health-check', err)
    })
  }, { timezone: TZ })
}
