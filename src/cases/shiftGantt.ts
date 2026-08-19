import { getJobTasks, updateTask } from '../integrations/jobtread'
import { updateEvent } from '../integrations/googleCalendar'
import { supabase } from '../db/client'

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface ShiftResult {
  deltaDays: number
  shiftedTasks: number
  shiftedEvents: number
}

// When a PM reports a delay with a new completion date, shift all future Jobtread
// tasks forward by the gap between the earliest upcoming end date and the new date.
// Then update matching Google Calendar events so the calendar stays in sync.
export async function shiftJobGantt(jobId: string, newCompletionDate: string): Promise<ShiftResult> {
  const today = new Date().toISOString().slice(0, 10)
  const tasks = await getJobTasks(jobId)

  const futureTasks = tasks.filter(t => t.endDate != null && t.endDate >= today)
  if (futureTasks.length === 0) return { deltaDays: 0, shiftedTasks: 0, shiftedEvents: 0 }

  futureTasks.sort((a, b) => a.endDate!.localeCompare(b.endDate!))
  const currentStageEnd = futureTasks[0].endDate!

  const deltaDays = Math.round(
    (new Date(newCompletionDate).getTime() - new Date(currentStageEnd).getTime())
    / (1000 * 60 * 60 * 24),
  )

  if (deltaDays <= 0) return { deltaDays, shiftedTasks: 0, shiftedEvents: 0 }

  // Shift Jobtread task dates and track new values for calendar sync
  const taskUpdates = new Map<string, { newStart: string | null; newEnd: string }>()

  for (const task of futureTasks) {
    const newEnd = addDays(task.endDate!, deltaDays)
    const newStart = task.startDate && task.startDate >= today
      ? addDays(task.startDate, deltaDays)
      : task.startDate ?? null

    const input: Parameters<typeof updateTask>[1] = { endDate: newEnd }
    if (newStart !== task.startDate) input.startDate = newStart ?? undefined

    await updateTask(task.id, input)
    taskUpdates.set(task.id, { newStart, newEnd })
  }

  // Update Google Calendar events for shifted tasks
  const { data: syncRows } = await supabase
    .from('calendar_sync')
    .select('jobtread_task_id, google_event_id')
    .in('jobtread_task_id', [...taskUpdates.keys()])

  let shiftedEvents = 0
  for (const row of syncRows ?? []) {
    const update = taskUpdates.get(row.jobtread_task_id)
    if (!update) continue

    // 200ms spacing to stay within Google Calendar API quota
    await new Promise(r => setTimeout(r, 200))

    try {
      await updateEvent(row.google_event_id, {
        end: update.newEnd,
        ...(update.newStart ? { start: update.newStart } : {}),
      })

      await supabase
        .from('calendar_sync')
        .update({
          task_start: update.newStart,
          task_end: update.newEnd,
          last_synced_at: new Date().toISOString(),
        })
        .eq('jobtread_task_id', row.jobtread_task_id)

      shiftedEvents++
    } catch (err) {
      console.error(
        `[shift-gantt] Failed to update calendar event ${row.google_event_id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { deltaDays, shiftedTasks: futureTasks.length, shiftedEvents }
}
