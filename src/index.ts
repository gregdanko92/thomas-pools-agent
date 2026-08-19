import 'dotenv/config'
import Fastify from 'fastify'
import { startSlackApp } from './integrations/slack'
import { registerStatusCommand } from './cases/status'
import { registerPmCheckinReplyHandler } from './cases/pmCheckinReply'
import { startMorningHealthCheck, runMorningHealthCheck } from './cron/morningHealthCheck'
import { startEveningReport, runEveningReport } from './cron/eveningReport'
import { startVendorOutreach, runVendorOutreach } from './cron/vendorOutreach'
import { startCalendarSync, runCalendarSync } from './cron/calendarSync'
import { startPaymentReminders, runPaymentReminders } from './cron/paymentReminders'
import { startPmCheckin, runPmCheckin } from './cron/pmCheckin'
import { postErrorAlert } from './lib/errorAlert'
import { withLock } from './lib/cronLock'

const server = Fastify({ logger: true })

server.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

server.post('/cron/morning', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  withLock('morning-health-check', () => runMorningHealthCheck()).catch(async err => {
    server.log.error({ err }, 'manual morning health check failed')
    await postErrorAlert('morning-health-check:manual', err)
  })
  return reply.status(202).send({ triggered: true })
})

server.post('/cron/evening', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  withLock('evening-report', () => runEveningReport()).catch(async err => {
    server.log.error({ err }, 'manual evening report failed')
    await postErrorAlert('evening-report:manual', err)
  })
  return reply.status(202).send({ triggered: true })
})

server.post('/cron/vendor-outreach', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  withLock('vendor-outreach', () => runVendorOutreach()).catch(async err => {
    server.log.error({ err }, 'manual vendor outreach failed')
    await postErrorAlert('vendor-outreach:manual', err)
  })
  return reply.status(202).send({ triggered: true })
})

server.post('/cron/calendar-sync', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  withLock('calendar-sync', () => runCalendarSync()).catch(async err => {
    server.log.error({ err }, 'manual calendar sync failed')
    await postErrorAlert('calendar-sync:manual', err)
  })
  return reply.status(202).send({ triggered: true })
})

server.post('/cron/payment-reminders', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  withLock('payment-reminders', () => runPaymentReminders()).catch(async err => {
    server.log.error({ err }, 'manual payment reminders failed')
    await postErrorAlert('payment-reminders:manual', err)
  })
  return reply.status(202).send({ triggered: true })
})

server.post('/cron/pm-checkin', async (req, reply) => {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  withLock('pm-checkin', () => runPmCheckin()).catch(async err => {
    server.log.error({ err }, 'manual pm check-in failed')
    await postErrorAlert('pm-checkin:manual', err)
  })
  return reply.status(202).send({ triggered: true })
})

const start = async () => {
  try {
    registerStatusCommand()
    registerPmCheckinReplyHandler()
    startMorningHealthCheck()
    startEveningReport()
    startVendorOutreach()
    startCalendarSync()
    startPaymentReminders()
    startPmCheckin()
    const port = Number(process.env.PORT) || 3000
    await server.listen({ port, host: '0.0.0.0' })
    await startSlackApp()
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
