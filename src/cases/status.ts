import { listJobs, getJob } from '../integrations/jobtread'
import type { Job, JobDetail } from '../integrations/jobtread'
import { registerSlashCommand } from '../integrations/slack'
import { complete } from '../integrations/claude'

const SYSTEM_PROMPT = `You are a project status assistant for Thomas Pools, a pool construction company.
Summarize job status for a project manager in plain text, under 250 words.
Cover: current job status, task progress (how many done vs total), any overdue or blocked items, recent activity from comments, and next steps.
Be direct and factual. No markdown headers — write in short paragraphs.`

function findAllMatches(jobs: Job[], query: string): Job[] {
  const q = query.toLowerCase()
  return jobs.filter(j => j.name.toLowerCase().includes(q))
}

function buildPrompt(job: JobDetail): string {
  const lines: string[] = []

  lines.push(`Job: ${job.name}`)
  lines.push(`Status: ${job.status}`)
  lines.push(`Start Date: ${job.startDate ?? 'not set'}`)
  lines.push(`End Date: ${job.endDate ?? 'not set'}`)
  if (job.location) {
    const addr = job.location.address ? ` — ${job.location.address}` : ''
    lines.push(`Location: ${job.location.name}${addr}`)
  }

  lines.push('')
  lines.push(`Tasks (${job.tasks.length} total):`)
  if (job.tasks.length === 0) {
    lines.push('  (none)')
  } else {
    for (const task of job.tasks) {
      const assigned = task.assignedUsers.map(u => u.name).join(', ') || 'unassigned'
      const dates = [task.startDate, task.endDate].filter(Boolean).join(' to ')
      lines.push(`  - ${task.name} [${task.status}]${dates ? ` (${dates})` : ''} — ${assigned}`)
    }
  }

  lines.push('')
  lines.push(`Documents (${job.documents.length}):`)
  if (job.documents.length === 0) {
    lines.push('  (none)')
  } else {
    for (const doc of job.documents) {
      const total = doc.total !== null ? ` — $${doc.total.toLocaleString()}` : ''
      lines.push(`  - ${doc.name} [${doc.type} / ${doc.status}]${total}`)
    }
  }

  // Sort ascending by createdAt so slice(-5) reliably gets the 5 most recent,
  // regardless of API return order. Null dates sort to the front and are excluded.
  const sortedComments = [...job.comments].sort((a, b) =>
    (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
  )
  const recentComments = sortedComments.slice(-5)
  lines.push('')
  lines.push(`Recent Comments (${recentComments.length} of ${job.comments.length}):`)
  if (recentComments.length === 0) {
    lines.push('  (none)')
  } else {
    for (const c of recentComments) {
      const author = c.createdBy?.name ?? 'Unknown'
      const date = (c.createdAt ?? '').slice(0, 10) || 'unknown date'
      lines.push(`  [${date}] ${author}: ${c.message}`)
    }
  }

  return `Provide a status summary for this job:\n\n${lines.join('\n')}`
}

export async function runStatusCase(jobName: string): Promise<string> {
  const jobs = await listJobs()
  const matches = findAllMatches(jobs, jobName)

  if (matches.length === 0) {
    return `No job found matching "${jobName}". Check the job name and try again.`
  }

  // Always prefer an exact name match, even when there are many partial matches.
  const exact = matches.find(j => j.name.toLowerCase() === jobName.toLowerCase())
  if (!exact && matches.length > 5) {
    const listed = matches.slice(0, 5).map(j => `• ${j.name}`).join('\n')
    return `Found ${matches.length} jobs matching "${jobName}" — be more specific:\n${listed}\n…and ${matches.length - 5} more`
  }

  const job = exact ?? matches[0]
  const detail = await getJob(job.id)
  const prompt = buildPrompt(detail)
  return complete(prompt, { system: SYSTEM_PROMPT })
}

export function registerStatusCommand(): void {
  registerSlashCommand('/jobstatus', async ({ command, ack, respond }) => {
    await ack()
    const jobName = command.text.trim()
    if (!jobName) {
      await respond('Usage: `/status [job name]`')
      return
    }
    try {
      const reply = await runStatusCase(jobName)
      await respond(reply)
    } catch (err) {
      await respond(`Error fetching status: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
