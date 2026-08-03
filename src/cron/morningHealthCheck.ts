import cron from 'node-cron'
import { listJobs, getJob } from '../integrations/jobtread'
import type { JobDetail } from '../integrations/jobtread'
import { postMessage } from '../integrations/slack'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'

const ACTIVE_STATUSES = ['created', 'pending', 'approved']
const TZ = 'America/Los_Angeles'

const SYSTEM_PROMPT = `You are a morning briefing assistant for Thomas Pools, a pool construction company.
You will receive data for all active jobs. Your job is to identify which ones need attention TODAY and summarize only those.
Use Slack formatting: wrap each job name in *asterisks* to make it bold. No other markdown — no headers, no bullet symbols, no dashes.

Focus on jobs that have: pending documents awaiting customer action, denied documents needing follow-up, recent customer comments requiring a response, or jobs that have been open a long time with no activity.
Skip jobs that are progressing normally with no blockers.
For each flagged job, write the job name in bold, then the reason it needs attention, then put the recommended action on its own new line starting with "Action:".
Keep the entire summary under 600 words. End with two lines: "Jobs needing attention: N" and "Total active jobs: M".`

function buildPrompt(jobs: JobDetail[], totalActive: number): string {
  const headerDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: TZ,
  })

  const lines: string[] = [
    `Morning health check — ${headerDate}`,
    `Total active jobs: ${totalActive}. Review all and flag only those needing attention today.`,
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

  return `Review all active jobs below and produce a focused morning briefing:\n\n${lines.join('\n')}`
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
    jobsReviewed = totalActive

    const results = await Promise.allSettled(activeJobs.map(j => getJob(j.id)))
    const details = results
      .filter((r): r is PromiseFulfilledResult<JobDetail> => r.status === 'fulfilled')
      .map(r => r.value)

    if (details.length === 0) throw new Error('All getJob calls failed — no data to report')

    const summary = await complete(buildPrompt(details, totalActive), { system: SYSTEM_PROMPT })

    await postMessage(channel, summary)

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
