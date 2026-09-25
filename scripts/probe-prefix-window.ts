import 'dotenv/config'

const PAVE_URL = 'https://api.jobtread.com/pave'

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

async function queryPrefix(prefix: string, from: string, to: string) {
  const data = await pave({
    organization: {
      $: { id: process.env.JOBTREAD_ORG_ID?.trim() },
      tasks: {
        $: { where: { and: [['name', 'like', `${prefix}%`], ['endDate', '>=', from], ['endDate', '<=', to]] } },
        nodes: { id: true, name: true, endDate: true, job: { id: true, name: true } },
      },
    },
  })
  const org = data.organization as Record<string, unknown>
  return (org.tasks as { nodes: unknown[] }).nodes
}

async function main() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() + 5)
  const lookahead = cutoff.toISOString().slice(0, 10)
  console.log(`Window: ${today} → ${lookahead}\n`)

  // Test a few representative prefixes to confirm 3-condition AND works
  const testPrefixes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
                        'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']
  let totalFound = 0

  for (const prefix of testPrefixes) {
    const tasks = await queryPrefix(prefix, today, lookahead)
    if (tasks.length > 0) {
      console.log(`${prefix}%: ${tasks.length} task(s)`)
      for (const t of tasks as Array<{ id: string; name: string; endDate: string; job: { id: string; name: string } }>) {
        console.log(`  - [${t.job.name}] ${t.name} (ends ${t.endDate})`)
      }
      totalFound += tasks.length
    } else {
      process.stdout.write('.')
    }
  }

  console.log(`\n\nTotal tasks found via prefix scan: ${totalFound}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
