/**
 * Setup/teardown helper for GRE-31 testing.
 * Only touches test job 22PcxVVzRLCk — never real jobs.
 *
 * Note: The Jobtread Pave API createTask requires an undocumented "task target"
 * entity that we haven't been able to resolve. Create tasks manually in the
 * Jobtread UI before running Gantt-shift scenarios (5, 6, 9, 10).
 *
 * Usage:
 *   npx tsx scripts/test-gre31-setup.ts             # show current state
 *   npx tsx scripts/test-gre31-setup.ts --reset      # delete all pm_checkin_threads for test job
 *   npx tsx scripts/test-gre31-setup.ts --shift-dates <offset>
 *       # set all test job task end dates to today+<offset> (requires tasks to exist)
 *   npx tsx scripts/test-gre31-setup.ts --fake-cooldown
 *       # insert a fake 'confirmed' thread row to simulate cooldown being active
 *   npx tsx scripts/test-gre31-setup.ts --fake-yesterday
 *       # backdate the most recent pending thread to yesterday (for nudge test)
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const TEST_JOB_ID = '22PcxVVzRLCk'
const TEST_CHANNEL = 'U0BJXKM8TM0' // Greg's DM (test mode target)
const GRANT_KEY = process.env.JOBTREAD_GRANT_KEY?.trim() ?? ''

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function paveRaw(query: object): Promise<string> {
  const res = await fetch('https://api.jobtread.com/pave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { $: { grantKey: GRANT_KEY }, ...query } }),
  })
  return res.text()
}

async function pave(query: object): Promise<unknown> {
  const text = await paveRaw(query)
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    if (data.errors) throw new Error(JSON.stringify(data.errors))
    return data
  } catch {
    throw new Error(text)
  }
}

interface RawTask {
  id: string
  name: string
  startDate: string | null
  endDate: string | null
}

async function getTestJobTasks(): Promise<RawTask[]> {
  const data = await pave({
    job: {
      $: { id: TEST_JOB_ID },
      tasks: { nodes: { id: true, name: true, startDate: true, endDate: true } },
    },
  }) as { job: { tasks: { nodes: RawTask[] } } }
  return data.job.tasks.nodes
}

function addDays(dateStr: string | null, days: number): string {
  const d = new Date(dateStr ?? new Date().toISOString().slice(0, 10))
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function printStatus(): Promise<void> {
  console.log('\n=== Test Job Tasks (22PcxVVzRLCk) ===')
  const tasks = await getTestJobTasks()
  if (tasks.length === 0) {
    console.log('  (no tasks — create them manually in Jobtread UI before Gantt scenarios)')
    console.log('  Task names must contain "permit" or "engineering" to match the check-in stage.')
  } else {
    for (const t of tasks) {
      console.log(`  ${t.id}  "${t.name}"  ${t.startDate ?? 'no-start'} → ${t.endDate ?? 'no-end'}`)
    }
  }

  console.log('\n=== pm_checkin_threads ===')
  const { data } = await supabase
    .from('pm_checkin_threads')
    .select('thread_ts, status, checkin_date, checkin_stage, conversation_history')
    .eq('jobtread_job_id', TEST_JOB_ID)
    .order('created_at', { ascending: false })
    .limit(5)

  if (!data || data.length === 0) {
    console.log('  (no rows)')
  } else {
    for (const row of data) {
      const histLen = Array.isArray(row.conversation_history) ? row.conversation_history.length : 0
      console.log(`  ${row.thread_ts}  status=${row.status}  date=${row.checkin_date}  history=${histLen} msg(s)`)
    }
  }
  console.log()
}

async function resetThreads(): Promise<void> {
  const { error, count } = await supabase
    .from('pm_checkin_threads')
    .delete({ count: 'exact' })
    .eq('jobtread_job_id', TEST_JOB_ID)

  if (error) throw new Error(`Reset failed: ${error.message}`)
  console.log(`Deleted ${count ?? 0} pm_checkin_threads row(s) for test job.`)
}

async function shiftTaskDates(offsetDays: number): Promise<void> {
  const tasks = await getTestJobTasks()
  if (tasks.length === 0) {
    console.log('No tasks found — create them in Jobtread UI first.')
    return
  }
  const today = new Date().toISOString().slice(0, 10)
  const newEnd = addDays(today, offsetDays)
  const newStart = today

  for (const task of tasks) {
    const text = await paveRaw({
      updateTask: {
        $: { input: { id: task.id, startDate: newStart, endDate: newEnd } },
        id: true,
        startDate: true,
        endDate: true,
      },
    })
    console.log(`  Updated "${task.name}" → ${newStart} – ${newEnd}  (raw: ${text.slice(0, 80)})`)
  }
  console.log(`\nAll tasks set to end ${offsetDays} day(s) from today (${newEnd}).`)
}

async function fakeCooldown(): Promise<void> {
  const { error } = await supabase.from('pm_checkin_threads').insert({
    thread_ts: `fake-cooldown-${Date.now()}`,
    slack_channel_id: TEST_CHANNEL,
    jobtread_job_id: TEST_JOB_ID,
    jobtread_job_name: 'Test Job',
    pm_name: 'Mark',
    pm_slack_user_id: '',
    checkin_stage: 'Engineering / Permitting',
    conversation_history: [],
    status: 'confirmed',
    checkin_date: new Date().toISOString().slice(0, 10),
  })
  if (error) throw new Error(`Insert failed: ${error.message}`)
  console.log('Inserted fake confirmed thread (cooldown is now active).')
}

async function fakeYesterday(): Promise<void> {
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1)
  const { data, error } = await supabase
    .from('pm_checkin_threads')
    .update({ checkin_date: yesterday })
    .eq('jobtread_job_id', TEST_JOB_ID)
    .eq('status', 'pending')
    .select('thread_ts')

  if (error) throw new Error(`Update failed: ${error.message}`)
  if (!data || data.length === 0) {
    console.log('No pending thread found to backdate. Trigger the cron first to create one.')
    return
  }
  console.log(`Backdated ${data.length} pending thread(s) to ${yesterday}. Trigger cron to see nudge.`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--status')) {
    await printStatus()
    return
  }

  if (args.includes('--reset')) {
    await resetThreads()
    await printStatus()
    return
  }

  if (args.includes('--shift-dates')) {
    const idx = args.indexOf('--shift-dates')
    const offset = parseInt(args[idx + 1] ?? '3')
    if (isNaN(offset)) {
      console.error('Usage: --shift-dates <number>  e.g. --shift-dates 3')
      process.exit(1)
    }
    await shiftTaskDates(offset)
    await printStatus()
    return
  }

  if (args.includes('--fake-cooldown')) {
    await fakeCooldown()
    await printStatus()
    return
  }

  if (args.includes('--fake-yesterday')) {
    await fakeYesterday()
    await printStatus()
    return
  }

  console.log(`
Usage:
  npx tsx scripts/test-gre31-setup.ts                     # show state
  npx tsx scripts/test-gre31-setup.ts --reset              # delete test threads
  npx tsx scripts/test-gre31-setup.ts --shift-dates 3      # set task ends to today+3
  npx tsx scripts/test-gre31-setup.ts --shift-dates 8      # today+8 (outside window)
  npx tsx scripts/test-gre31-setup.ts --shift-dates 1      # tomorrow (deadline eve)
  npx tsx scripts/test-gre31-setup.ts --fake-cooldown      # simulate active cooldown
  npx tsx scripts/test-gre31-setup.ts --fake-yesterday     # backdate pending thread (nudge test)
`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
