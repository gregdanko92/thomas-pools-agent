import 'dotenv/config'
import Fastify from 'fastify'
import { startSlackApp } from './integrations/slack'
import { registerStatusCommand } from './cases/status'

const server = Fastify({ logger: true })

server.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

const start = async () => {
  try {
    registerStatusCommand()
    const port = Number(process.env.PORT) || 3000
    await server.listen({ port, host: '0.0.0.0' })
    await startSlackApp()
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
