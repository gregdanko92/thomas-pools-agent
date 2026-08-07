import 'dotenv/config'
import Fastify from 'fastify'
import { startSlackApp } from './integrations/slack'
import { registerStatusCommand } from './cases/status'
import { startMorningHealthCheck, runMorningHealthCheck } from './cron/morningHealthCheck'
import { startEveningReport, runEveningReport } from './cron/eveningReport'
import { startVendorOutreach, runVendorOutreach } from './cron/vendorOutreach'
import { startCalendarSync, runCalendarSync } from './cron/calendarSync'

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

server.post('/cron/vendor-outreach', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  runVendorOutreach().catch(err =>
    server.log.error({ err }, 'manual vendor outreach failed'),
  )
  return reply.status(202).send({ triggered: true })
})

server.post('/cron/calendar-sync', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  runCalendarSync().catch(err =>
    server.log.error({ err }, 'manual calendar sync failed'),
  )
  return reply.status(202).send({ triggered: true })
})

const start = async () => {
  try {
    registerStatusCommand()
    startMorningHealthCheck()
    startEveningReport()
    startVendorOutreach()
    startCalendarSync()
    const port = Number(process.env.PORT) || 3000
    await server.listen({ port, host: '0.0.0.0' })
    await startSlackApp()
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
