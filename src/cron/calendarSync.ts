import cron from 'node-cron'
import { listJobs, getJobTasks } from '../integrations/jobtread'
import type { Job, Task } from '../integrations/jobtread'
import { createEvent, updateEvent } from '../integrations/googleCalendar'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'

const TZ = 'America/Los_Angeles'

const ACTIVE_STAGES = [
  'Sold', 'On Hold', 'Engineering / Permitting', 'Excavation',
  'Plumbing / Electric', 'Gunnite', 'Coping / Tile',
  'Hardscape / Landscape', 'Fence & Gate', 'Plaster',
]

export interface CalendarSyncResult {
  created: number
  updated: number
  errors: number
}

interface SyncRow {
  jobtread_task_id: string
  google_event_id: string
  task_name: string
  task_start: string | null
  task_end: string | null
}

// != null check required: job.location.address is string | null, and null is falsy so a bare &&
// would fall back to the placeholder name even when the location record exists.
function jobDisplayName(job: Job): string {
  return /^job\s/i.test(job.name) && job.location?.address != null
    ? job.location.address
    : job.name
}

// Google Calendar requires end strictly after start for date-only events.
// Tasks with only a startDate get a one-day window so the event is visible.
function resolveEnd(task: Task): string {
  if (task.endDate) return task.endDate
  const d = new Date(task.startDate!)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export async function runCalendarSync(): Promise<CalendarSyncResult> {
  let created = 0
  let updated = 0
  let errors = 0

  const activeJobs = await listJobs({ stages: ACTIVE_STAGES })

  // .in('col', []) behavior is undefined across PostgREST versions — some return all rows.
  if (activeJobs.length === 0) return { created: 0, updated: 0, errors: 0 }

  const jobIds = activeJobs.map(j => j.id)

  // Fetch all existing sync rows for active jobs in one query
  const { data: syncRows, error: syncErr } = await supabase
    .from('calendar_sync')
    .select('jobtread_task_id, google_event_id, task_name, task_start, task_end')
    .in('jobtread_job_id', jobIds)

  if (syncErr) throw new Error(`Failed to fetch calendar_sync: ${syncErr.message}`)

  const syncMap = new Map<string, SyncRow>(
    (syncRows ?? []).map(r => [r.jobtread_task_id, r as SyncRow]),
  )

  // Fetch tasks for all active jobs in parallel — only tasks needed, not full job detail
  const taskResults = await Promise.allSettled(
    activeJobs.map(job => getJobTasks(job.id).then(tasks => ({ job, tasks }))),
  )

  for (const result of taskResults) {
    if (result.status === 'rejected') {
      errors++
      console.error(
        '[calendar-sync] Failed to fetch tasks:',
        result.reason instanceof Error ? result.reason.message : result.reason,
      )
      continue
    }

    const { job, tasks } = result.value
    const displayName = jobDisplayName(job)
    // Always include location so a cleared address is propagated to the Google event (empty string = no location).
    const location = job.location?.address ?? ''

    for (const task of tasks) {
      if (!task.startDate) continue

      // Google Calendar API default quota is ~10 req/s; 200ms spacing keeps us under it.
      await new Promise(r => setTimeout(r, 200))

      const title = `${displayName} — ${task.name}`
      const end = resolveEnd(task)
      const existing = syncMap.get(task.id)

      try {
        if (existing) {
          const changed =
            existing.task_name !== task.name ||
            existing.task_start !== task.startDate ||
            existing.task_end !== (task.endDate ?? null)

          if (changed) {
            await updateEvent(existing.google_event_id, { title, start: task.startDate, end, location })

            const { error: updateErr } = await supabase
              .from('calendar_sync')
              .update({
                task_name: task.name,
                task_start: task.startDate,
                task_end: task.endDate ?? null,
                last_synced_at: new Date().toISOString(),
              })
              .eq('jobtread_task_id', task.id)

            if (updateErr) {
              console.error(`[calendar-sync] Google event updated for task ${task.id} but sync row update failed (will re-update next run):`, updateErr.message)
              errors++
            } else {
              updated++
            }
          }
        } else {
          const event = await createEvent({ title, start: task.startDate, end, location })

          const { error: insertErr } = await supabase.from('calendar_sync').insert({
            jobtread_task_id: task.id,
            jobtread_job_id: job.id,
            google_event_id: event.id,
            task_name: task.name,
            task_start: task.startDate,
            task_end: task.endDate ?? null,
          })

          if (insertErr) {
            // The Google Calendar event was created — log its ID so it can be manually cleaned up.
            console.error(`[calendar-sync] Google event ${event.id} created for task ${task.id} but sync row insert failed (event will be duplicated next run):`, insertErr.message)
            errors++
          } else {
            created++
          }
        }
      } catch (err) {
        console.error(
          `[calendar-sync] Failed to sync task ${task.id} (${task.name}):`,
          err instanceof Error ? err.message : err,
        )
        errors++
      }
    }
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'calendar_sync',
    details: { created, updated, errors, jobCount: activeJobs.length },
    success: errors === 0,
  }).then(() => undefined, () => undefined)

  return { created, updated, errors }
}

// Fires hourly — frequent enough to catch new Jobtread tasks within the hour they're added.
export function startCalendarSync(): void {
  cron.schedule('0 * * * *', () => {
    runCalendarSync().then(r => {
      if (r.created > 0 || r.updated > 0 || r.errors > 0) {
        console.log(`[calendar-sync] created=${r.created} updated=${r.updated} errors=${r.errors}`)
      }
    }).catch(async err => {
      console.error('[calendar-sync]', err instanceof Error ? err.message : err)
      await postErrorAlert('calendar-sync', err)
    })
  }, { timezone: TZ })
}
