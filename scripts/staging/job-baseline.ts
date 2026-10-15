// Saves or restores the task dates of the allowlisted test jobs, so features that move
// dates (e.g. shiftGantt) can be re-tested from a known state.
// Usage: npm run staging:save-job      — record current dates as the baseline
//        npm run staging:reset-job     — put any drifted dates back to the baseline
import './loadEnv'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { getJobTasks, updateTask } from '../../src/integrations/jobtread'
import { allowedJobIds } from '../../src/lib/env'

const BASELINE_PATH = 'scripts/staging/job-baseline.json'

type Baseline = Record<string, Array<{ id: string; name: string; startDate: string | null; endDate: string | null }>>

async function save() {
  const baseline: Baseline = {}
  for (const jobId of allowedJobIds()) {
    const tasks = await getJobTasks(jobId)
    baseline[jobId] = tasks.map(t => ({ id: t.id, name: t.name, startDate: t.startDate, endDate: t.endDate }))
    console.log(`${jobId}: saved ${tasks.length} tasks`)
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.log(`Baseline written to ${BASELINE_PATH}`)
}

async function restore() {
  if (!existsSync(BASELINE_PATH)) throw new Error(`No baseline at ${BASELINE_PATH} — run npm run staging:save-job first`)
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  for (const [jobId, saved] of Object.entries(baseline)) {
    const current = new Map((await getJobTasks(jobId)).map(t => [t.id, t]))
    let restored = 0
    for (const task of saved) {
      const now = current.get(task.id)
      if (!now) { console.warn(`  ${task.name} (${task.id}) no longer exists — skipped`); continue }
      if (now.startDate === task.startDate && now.endDate === task.endDate) continue
      // Only dates the baseline has are restored; a date added since the snapshot is left as-is.
      const input: { startDate?: string; endDate?: string } = {}
      if (task.startDate) input.startDate = task.startDate
      if (task.endDate) input.endDate = task.endDate
      await updateTask(task.id, input)
      console.log(`  ${task.name}: ${now.startDate} → ${now.endDate}  ⇒  ${task.startDate} → ${task.endDate}`)
      restored++
    }
    console.log(`${jobId}: restored ${restored} task(s)`)
  }
}

const mode = process.argv[2]
const run = mode === 'save' ? save : mode === 'restore' ? restore : null
if (!run) { console.error('Usage: job-baseline.ts <save | restore>'); process.exit(1) }
run().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
