import cron from 'node-cron'
import { listJobs, getJob } from '../integrations/jobtread'
import type { JobDetail } from '../integrations/jobtread'
import { postMessage } from '../integrations/slack'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'

const ACTIVE_STATUSES = ['created', 'pending', 'approved']
const MAX_DETAIL_JOBS = 15
const TZ = 'America/Los_Angeles'

const SYSTEM_PROMPT = `You are a morning briefing assistant for Thomas Pools, a pool construction company.
Write a concise daily health check for the project management team. Plain text only, no markdown headers or bullet symbols.
For each job, note its status, any pending documents awaiting customer action, recent customer comments, and what needs attention today.
If a job has no activity or tasks, say so briefly. Flag anything urgent.
Keep the entire summary under 500 words. End with a one-line count: "Active jobs reviewed: N".`

function buildPrompt(jobs: JobDetail[], totalActive: number): string {
  const headerDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: TZ,
  })

  const lines: string[] = [
    `Morning health check — ${headerDate}`,
    `Showing ${jobs.length} of ${totalActive} active jobs.`,
    '',
  ]

  for (const job of jobs) {
    lines.push(`JOB: ${job.name}`)
    lines.push(`Status: ${job.status} | Created: ${(job.createdAt ?? '').slice(0, 10) || 'unknown'}`)
    if (job.location?.address) lines.push(`Location: ${job.location.address}`)

    if (job.tasks.length === 0) {
      lines.push('Tasks: none')
    } else {
      const taskList = job.tasks
        .map(t => `${t.name} (${t.isToDo ? 'to-do' : 'scheduled'})`)
        .join(', ')
      lines.push(`Tasks (${job.tasks.length}): ${taskList}`)
    }

    for (const doc of job.documents) {
      const price = doc.price !== null ? ` $${doc.price.toLocaleString()}` : ''
      lines.push(`Document: ${doc.name} [${doc.type}/${doc.status}]${price}`)
    }

    const sorted = [...job.comments].sort((a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
    )
    for (const c of sorted.slice(-2)) {
      const author = c.account?.name ?? 'Unknown'
      const commentDate = (c.createdAt ?? '').slice(0, 10) || 'unknown date'
      lines.push(`Comment (${commentDate} — ${author}): ${c.message}`)
    }

    lines.push('')
  }

  return `Generate a morning project health check from the following job data:\n\n${lines.join('\n')}`
}

export async function runMorningHealthCheck(): Promise<void> {
  let channel = ''
  let totalActive = 0
  let jobsReviewed = 0

  try {
    const id = process.env.SLACK_MORNING_CHANNEL
    if (!id) throw new Error('SLACK_MORNING_CHANNEL is not set')
    channel = id

    const activeJobs = await listJobs({ statuses: ACTIVE_STATUSES })
    totalActive = activeJobs.length

    const toFetch = activeJobs.slice(0, MAX_DETAIL_JOBS)
    jobsReviewed = toFetch.length

    const results = await Promise.allSettled(toFetch.map(j => getJob(j.id)))
    const details = results
      .filter((r): r is PromiseFulfilledResult<JobDetail> => r.status === 'fulfilled')
      .map(r => r.value)

    if (details.length === 0) throw new Error('All getJob calls failed — no data to report')

    const summary = await complete(buildPrompt(details, totalActive), { system: SYSTEM_PROMPT })

    await postMessage(channel, summary)

    // Audit logs are best-effort: don't let them mask a successful report delivery.
    await Promise.allSettled([
      supabase.from('daily_reports').insert({
        report_type: 'morning',
        slack_channel: channel,
        content: summary,
      }),
      supabase.from('agent_run_log').insert({
        run_type: 'morning_check',
        details: { totalActive, jobsReviewed, detailsFetched: details.length },
        success: true,
      }),
    ])
  } catch (err) {
    await supabase.from('agent_run_log').insert({
      run_type: 'morning_check',
      details: { totalActive, jobsReviewed },
      success: false,
      error_message: err instanceof Error ? err.message : String(err),
    }).then(() => undefined, () => undefined)

    throw err
  }
}

// Fires daily at 7 AM America/Los_Angeles — construction crews work weekends.
export function startMorningHealthCheck(): void {
  cron.schedule('0 7 * * *', () => {
    runMorningHealthCheck().catch(err =>
      console.error('[morning-health-check]', err instanceof Error ? err.message : err),
    )
  }, { timezone: TZ })
}
