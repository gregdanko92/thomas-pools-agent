// Side-effect import: loads .env.staging and refuses to continue unless it is a
// genuine staging config. Must be the first import in every staging script, before
// anything that reads process.env at import time (e.g. the Supabase client).
import { config } from 'dotenv'
import { PROD_SUPABASE_HOST } from '../../src/lib/env'

config({ path: '.env.staging', override: true, quiet: true })

if (process.env.APP_ENV !== 'staging') {
  console.error('Refusing to run: .env.staging is missing or does not set APP_ENV=staging')
  process.exit(1)
}
if (!process.env.SUPABASE_URL || new URL(process.env.SUPABASE_URL).host === PROD_SUPABASE_HOST) {
  console.error('Refusing to run: SUPABASE_URL in .env.staging is missing or points at production')
  process.exit(1)
}
