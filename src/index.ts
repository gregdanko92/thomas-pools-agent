import 'dotenv/config'
import Fastify from 'fastify'
import { startSlackApp } from './integrations/slack'
import { registerStatusCommand } from './cases/status'
import { startMorningHealthCheck, runMorningHealthCheck } from './cron/morningHealthCheck'
import { startEveningReport, runEveningReport } from './cron/eveningReport'
import { registerSlackUpdateListener } from './cases/slackUpdate'

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

server.post('/cron/evening', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  runEveningReport().catch(err =>
    server.log.error({ err }, 'manual evening report failed'),
  )
  return reply.status(202).send({ triggered: true })
})

const start = async () => {
  try {
    registerStatusCommand()
    registerSlackUpdateListener()
    startMorningHealthCheck()
    startEveningReport()
    const port = Number(process.env.PORT) || 3000
    await server.listen({ port, host: '0.0.0.0' })
    await startSlackApp()
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
