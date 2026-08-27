import 'dotenv/config'

// Probes the Jobtread Pave API to discover the shape of task dependency fields.
// Only reads from the test job — no mutations.

const PAVE_URL = 'https://api.jobtread.com/pave'
const TEST_JOB_ID = '22PcxVVzRLCk'

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

// Fetch task IDs from the test job to use in direct task queries
async function getTestTaskIds(): Promise<Array<{ id: string; name: string }>> {
  const data = await pave({
    job: {
      $: { id: TEST_JOB_ID },
      tasks: { nodes: { id: true, name: true } },
    },
  })
  const job = data.job as Record<string, unknown>
  return (job.tasks as { nodes: Array<{ id: string; name: string }> }).nodes
}

async function probeTaskField(taskId: string, field: string, withNodes: boolean): Promise<unknown> {
  const fieldShape = withNodes ? { nodes: { id: true, name: true } } : { id: true, name: true }
  const data = await pave({
    task: {
      $: { id: taskId },
      id: true,
      name: true,
      [field]: fieldShape,
    },
  })
  return data.task
}

async function main() {
  // Step 1: get task IDs
  console.log('Fetching test job task IDs...')
  const tasks = await getTestTaskIds()
  console.log('Tasks:', tasks.map(t => `${t.id} — ${t.name}`).join('\n'))
  if (tasks.length === 0) {
    console.log('No tasks found on test job. Add tasks first.')
    return
  }
  const firstTaskId = tasks[0].id
  console.log(`\nUsing task: ${tasks[0].name} (${firstTaskId})\n`)

  const DEP_ID = '22PdRSXcqUcE' // known dependency node from previous probe
  const excavationId = tasks.find(t => t.name === 'Excavation')?.id ?? tasks[0].id

  // Probe more fields on the dependency node itself
  const depNodeFields = [
    'prerequisite', 'prerequisiteTask', 'dependency', 'dependencyTask',
    'reliesOn', 'blockedBy', 'before', 'after',
    'requiredTask', 'taskBefore', 'taskAfter',
    'parentTask', 'childTask', 'fromTask', 'toTask',
    'antecedent', 'consequent',
  ]

  console.log('--- Probe A: extra fields on taskDependency node (via Permit Application) ---\n')
  for (const field of depNodeFields) {
    try {
      const data = await pave({
        task: {
          $: { id: tasks[1].id }, // Permit Application
          taskDependencies: {
            nodes: {
              id: true,
              [field]: { id: true, name: true },
            },
          },
        },
      })
      const t = data.task as Record<string, unknown>
      const deps = t.taskDependencies as { nodes: unknown[] }
      console.log(`✓ nodes.${field}: ${JSON.stringify(deps.nodes)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`✗ nodes.${field}: ${msg.slice(0, 100)}`)
    }
  }

  // Probe Excavation for forward-pointing dependency fields
  const forwardFields = [
    'taskSuccessors', 'successorTasks', 'dependentTasks', 'taskDependents',
    'afterTasks', 'followedBy', 'blockedTasks', 'downstreamTasks',
  ]

  console.log('\n--- Probe B: forward-pointing fields on Excavation ---\n')
  for (const field of forwardFields) {
    try {
      const data = await pave({
        task: {
          $: { id: excavationId },
          id: true,
          [field]: { nodes: { id: true, name: true } },
        },
      })
      const t = data.task as Record<string, unknown>
      console.log(`✓ Excavation.${field}: ${JSON.stringify(t[field])}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`✗ Excavation.${field}: ${msg.slice(0, 100)}`)
    }
  }

  // Also try direct taskDependency (singular) query by dep ID
  console.log('\n--- Probe C: direct taskDependency query by dep ID ---\n')
  const singularFields = ['id', 'task', 'prerequisite', 'prerequisiteTask', 'dependencyTask', 'before', 'after']
  for (const field of singularFields) {
    try {
      const data = await pave({
        taskDependency: {
          $: { id: DEP_ID },
          id: true,
          [field]: field === 'id' ? true : { id: true, name: true },
        },
      })
      console.log(`✓ taskDependency.${field}: ${JSON.stringify(data.taskDependency)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`✗ taskDependency.${field}: ${msg.slice(0, 100)}`)
    }
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
