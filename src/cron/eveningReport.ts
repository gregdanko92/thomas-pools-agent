import cron from 'node-cron'
import { listJobs, getJob } from '../integrations/jobtread'
import type { JobDetail } from '../integrations/jobtread'
import { postMessage } from '../integrations/slack'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'

const ACTIVE_STATUSES = ['created', 'pending', 'approved']
const TZ = 'America/Los_Angeles'

const SYSTEM_PROMPT = `You are an evening reporting assistant for Thomas Pools, a pool construction company.
You produce a concise daily leadership summary of all active construction projects.
Use Slack formatting: wrap each job name in *asterisks* to make it bold. No other markdown — no headers, no bullet symbols, no dashes.

Leadership wants a high-level view, not per-PM detail. Organize your report in three sections:
1. "Blockers needing leadership action" — jobs with denied documents, escalated issues, or long-stalled work requiring executive attention.
2. "Progress highlights" — jobs that moved forward today (recent comments showing completed work, newly approved documents).
3. "Financial watch" — jobs with pending proposal/contract documents awaiting customer signature, with dollar amounts where available.

For each job mentioned, write the job name in bold, then one line of context.
Skip jobs with no activity and no pending documents — they don't need to appear.
End with three lines: "Total active jobs: N", "Jobs with blockers: B", "Jobs with pending documents: D".
Keep the entire report under 700 words.`

function buildPrompt(jobs: JobDetail[], totalActive: number): string {
  const headerDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: TZ,
  })

  const lines: string[] = [
    `Evening leadership report — ${headerDate}`,
    `Total active jobs: ${totalActive}. Produce a leadership summary.`,
    '',
  ]

  for (const job of jobs) {
    const name = /^job\s/i.test(job.name) && job.location?.address
      ? `${job.name} — ${job.location.address}`
      : job.name
    lines.push(`JOB: ${name}`)
    lines.push(`Status: ${job.status} | Created: ${(job.createdAt ?? '').slice(0, 10) || 'unknown'}`)
    if (job.location?.address && !/^job\s/i.test(job.name)) lines.push(`Location: ${job.location.address}`)

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
    for (const c of sorted.slice(-3)) {
      const author = c.account?.name ?? 'Unknown'
      const commentDate = (c.createdAt ?? '').slice(0, 10) || 'unknown date'
      lines.push(`Comment (${commentDate} — ${author}): ${c.message}`)
    }

    lines.push('')
  }

  return `Review all active jobs below and produce a focused evening leadership report:\n\n${lines.join('\n')}`
}

export async function runEveningReport(): Promise<void> {
  let channel = ''
  let totalActive = 0

  try {
    const id = process.env.SLACK_EVENING_CHANNEL
    if (!id) throw new Error('SLACK_EVENING_CHANNEL is not set')
    channel = id

    const activeJobs = await listJobs({ statuses: ACTIVE_STATUSES })
    totalActive = activeJobs.length

    if (activeJobs.length === 0) {
      await postMessage(channel, 'No active jobs tonight — nothing to report.')
      await supabase.from('agent_run_log').insert({
        run_type: 'evening_report',
        details: { totalActive: 0, jobsReviewed: 0, detailsFetched: 0 },
        success: true,
      })
      return
    }

    const results = await Promise.allSettled(activeJobs.map(j => getJob(j.id)))
    const details = results
      .filter((r): r is PromiseFulfilledResult<JobDetail> => r.status === 'fulfilled')
      .map(r => r.value)

    if (details.length === 0) throw new Error('All getJob calls failed — no job details to report')

    const summary = await complete(buildPrompt(details, totalActive), { system: SYSTEM_PROMPT })

    await postMessage(channel, summary)

    await Promise.allSettled([
      supabase.from('daily_reports').insert({
        report_type: 'evening',
        slack_channel: channel,
        content: summary,
      }),
      supabase.from('agent_run_log').insert({
        run_type: 'evening_report',
        details: { totalActive, detailsFetched: details.length },
        success: true,
      }),
    ])
  } catch (err) {
    await supabase.from('agent_run_log').insert({
      run_type: 'evening_report',
      details: { totalActive },
      success: false,
      error_message: err instanceof Error ? err.message : String(err),
    }).then(() => undefined, () => undefined)

    throw err
  }
}

// Fires daily at 5 PM America/Los_Angeles for end-of-day leadership review.
export function startEveningReport(): void {
  cron.schedule('0 17 * * *', () => {
    runEveningReport().catch(err =>
      console.error('[evening-report]', err instanceof Error ? err.message : err),
    )
  }, { timezone: TZ })
}
