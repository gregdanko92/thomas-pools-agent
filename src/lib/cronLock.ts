import { supabase } from '../db/client'

// How long a lock must be held before it's considered stale (process died mid-run).
const LOCK_STALE_MINUTES = 30

export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const staleAt = new Date(Date.now() - LOCK_STALE_MINUTES * 60 * 1000).toISOString()
  const now = new Date().toISOString()

  const { data: existing, error: selectErr } = await supabase
    .from('cron_locks')
    .select('acquired_at, released_at')
    .eq('lock_name', name)
    .maybeSingle()

  if (selectErr) throw new Error(`cron-lock: select failed for ${name}: ${selectErr.message}`)

  // Lock is held if recently acquired and not yet released — covers Railway redeploy races
  // and concurrent HTTP triggers that somehow both pass the in-process isRunning check.
  if (existing && existing.released_at === null && Date.parse(existing.acquired_at) > Date.parse(staleAt)) {
    console.warn(`[cron-lock] ${name} is already running (since ${existing.acquired_at}) — skipping`)
    return null
  }

  const { error: lockErr } = await supabase
    .from('cron_locks')
    .upsert({ lock_name: name, acquired_at: now, released_at: null }, { onConflict: 'lock_name' })

  if (lockErr) throw new Error(`cron-lock: acquire failed for ${name}: ${lockErr.message}`)

  try {
    return await fn()
  } finally {
    await supabase
      .from('cron_locks')
      .update({ released_at: new Date().toISOString() })
      .eq('lock_name', name)
      .then(() => undefined, releaseErr => {
        console.warn(`[cron-lock] Failed to release lock ${name} — will self-expire in ${LOCK_STALE_MINUTES}m:`, releaseErr instanceof Error ? releaseErr.message : releaseErr)
      })
  }
}
