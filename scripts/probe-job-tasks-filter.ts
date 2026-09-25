import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const PAVE_URL = 'https://api.jobtread.com/pave'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function pave(query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    query: { $: { grantKey: process.env.JOBTREAD_GRANT_KEY?.trim() }, ...query },
  })
  const res = await fetch(PAVE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  if (!res.ok) throw new Error(`Pave ${res.status}: ${await res.text()}`)
  const json = await res.json() as Record<string, unknown>
  const errors = json.errors as unknown[]
  if (Array.isArray(errors) && errors.length > 0) throw new Error(`Pave error: ${JSON.stringify(errors)}`)
  return json
}

async function queryJobTasksInWindow(jobId: string, from: string, to: string) {
  const data = await pave({
    job: {
      $: { id: jobId },
      tasks: {
        $: { where: { and: [['endDate', '>=', from], ['endDate', '<=', to]] } },
        nodes: { id: true, name: true, startDate: true, endDate: true },
      },
    },
  })
  const job = data.job as Record<string, unknown>
  return (job.tasks as { nodes: unknown[] }).nodes
}

async function main() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() + 5)
  const lookahead = cutoff.toISOString().slice(0, 10)
  console.log(`Window: ${today} → ${lookahead}\n`)

  const { data: channelRows, error } = await supabase
    .from('project_channels')
    .select('jobtread_job_id, jobtread_job_name')

  if (error) throw new Error(error.message)
  console.log(`Querying ${channelRows!.length} jobs from project_channels...\n`)

  let totalTasks = 0
  for (const row of channelRows!) {
    const tasks = await queryJobTasksInWindow(row.jobtread_job_id, today, lookahead)
    if (tasks.length > 0) {
      console.log(`✓ ${row.jobtread_job_name}: ${tasks.length} task(s)`)
      for (const t of tasks as Array<{ id: string; name: string; startDate: string; endDate: string }>) {
        console.log(`    - ${t.name} (${t.startDate ?? '?'} → ${t.endDate})`)
      }
      totalTasks += tasks.length
    }
  }

  console.log(`\nTotal tasks in window: ${totalTasks}`)
  console.log(`Total requests made: ${channelRows!.length} (one per job)`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
