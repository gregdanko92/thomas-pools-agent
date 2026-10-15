// Environment mode for the agent. Production is the live Thomas Pools deployment;
// staging is the isolated test deployment (own Supabase, own Slack app, Jobtread
// access restricted to an allowlist of test jobs). See docs/STAGING.md.

export type AppEnv = 'production' | 'staging'

// Fingerprints of the production resources. Staging must never hold these, and
// production must always hold them — checked at startup by assertSafeConfig().
export const PROD_SUPABASE_HOST = 'culswfxjnvxdffkjepku.supabase.co'
export const PROD_SLACK_APP_ID = 'A0BMC4CFZUK'

export function appEnv(): AppEnv {
  const raw = process.env.APP_ENV?.trim().toLowerCase()
  if (!raw || raw === 'production') return 'production'
  if (raw === 'staging') return 'staging'
  throw new Error(`APP_ENV must be "production" or "staging", got "${process.env.APP_ENV}"`)
}

export function isStaging(): boolean {
  return appEnv() === 'staging'
}

// Crons run on their schedules in production and are off in staging (trigger them
// via the /cron/* endpoints instead). CRONS_ENABLED overrides either default.
export function cronsEnabled(): boolean {
  const raw = process.env.CRONS_ENABLED?.trim().toLowerCase()
  if (raw === 'true') return true
  if (raw === 'false') return false
  return !isStaging()
}

// Jobtread jobs staging is allowed to touch. Empty in production (no restriction).
export function allowedJobIds(): Set<string> {
  const ids = (process.env.JOBTREAD_ALLOWED_JOB_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return new Set(ids)
}

// Staging only: lets reads see every real job (e.g. to preview a full morning report).
// Writes stay restricted to the allowlist regardless.
export function stagingReadAll(): boolean {
  return isStaging() && process.env.JOBTREAD_STAGING_READ_ALL === 'true'
}

export function canWriteJob(jobId: string): boolean {
  return !isStaging() || allowedJobIds().has(jobId)
}

export function canReadJob(jobId: string): boolean {
  return !isStaging() || stagingReadAll() || allowedJobIds().has(jobId)
}

export function assertCanWriteJob(jobId: string, action: string): void {
  if (!canWriteJob(jobId)) {
    throw new Error(`[staging guard] ${action} blocked: job ${jobId} is not in JOBTREAD_ALLOWED_JOB_IDS`)
  }
}

export function assertCanReadJob(jobId: string, action: string): void {
  if (!canReadJob(jobId)) {
    throw new Error(`[staging guard] ${action} blocked: job ${jobId} is not in JOBTREAD_ALLOWED_JOB_IDS`)
  }
}

// Staging posts only to the test channel.
export function testChannelId(): string {
  const id = process.env.SLACK_TEST_CHANNEL_ID?.trim()
  if (!id) throw new Error('SLACK_TEST_CHANNEL_ID is not set')
  return id
}

function supabaseHost(): string {
  const url = process.env.SUPABASE_URL
  if (!url) throw new Error('SUPABASE_URL is not set')
  return new URL(url).host
}

// Refuses to start if the configuration doesn't match the declared environment:
// staging holding production resources, or "production" holding anything else
// (which catches a staging service that forgot to set APP_ENV).
// slackAppId comes from the running bot token (see getSlackAppId()).
export function assertSafeConfig(slackAppId: string): void {
  const env = appEnv()
  const host = supabaseHost()
  const problems: string[] = []

  if (env === 'staging') {
    if (host === PROD_SUPABASE_HOST) problems.push('SUPABASE_URL points at the production database')
    if (slackAppId === PROD_SLACK_APP_ID) problems.push('Slack tokens belong to the production Slack app')
    if (allowedJobIds().size === 0) problems.push('JOBTREAD_ALLOWED_JOB_IDS is empty')
    if (!process.env.SLACK_TEST_CHANNEL_ID?.trim()) problems.push('SLACK_TEST_CHANNEL_ID is not set')
  } else {
    if (host !== PROD_SUPABASE_HOST) problems.push(`SUPABASE_URL (${host}) is not the production database — set APP_ENV=staging?`)
    if (slackAppId !== PROD_SLACK_APP_ID) problems.push(`Slack app ${slackAppId} is not the production app — set APP_ENV=staging?`)
  }

  if (problems.length > 0) {
    throw new Error(`Unsafe ${env} configuration, refusing to start:\n  - ${problems.join('\n  - ')}`)
  }
}
