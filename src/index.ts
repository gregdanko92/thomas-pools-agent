import 'dotenv/config'
import Fastify from 'fastify'
import { startSlackApp } from './integrations/slack'
import { registerStatusCommand } from './cases/status'
import { startMorningHealthCheck, runMorningHealthCheck } from './cron/morningHealthCheck'
import { listJobs } from './integrations/jobtread'

const server = Fastify({ logger: true })

server.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

server.post('/cron/morning', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  runMorningHealthCheck().catch(err =>
    server.log.error({ err }, 'manual morning health check failed'),
  )
  return reply.status(202).send({ triggered: true })
})

// Temporary: probe what fields exist on "Job N" placeholder-named jobs
server.get('/debug/job-fields', async (_req, reply) => {
  const jobs = await listJobs({ search: 'Job ' })
  if (jobs.length === 0) return reply.send({ error: 'no placeholder-named jobs found' })
  const jobId = jobs[0].id
  const jobName = jobs[0].name

  const PAVE_URL = 'https://api.jobtread.com/pave'
  const grantKey = process.env.JOBTREAD_GRANT_KEY?.trim() ?? ''

  const tryField = async (fieldQuery: Record<string, unknown>) => {
    const body = JSON.stringify({ query: { $: { grantKey }, job: { $: { id: jobId }, id: true, name: true, ...fieldQuery } } })
    const res = await fetch(PAVE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    const text = await res.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { ok: res.ok, status: res.status, body: parsed }
  }

  const [locationCustomerResult, numberResult] = await Promise.all([
    tryField({ location: { id: true, name: true, address: true, customer: { id: true, name: true } } }),
    tryField({ number: true }),
  ])

  return reply.send({ jobId, jobName, locationCustomer: locationCustomerResult, number: numberResult })
})

const start = async () => {
  try {
    registerStatusCommand()
    startMorningHealthCheck()
    const port = Number(process.env.PORT) || 3000
    await server.listen({ port, host: '0.0.0.0' })
    await startSlackApp()
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
