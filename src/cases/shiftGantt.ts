import { getJobTasks, updateTask, STAGE_TASK_KEYWORDS } from '../integrations/jobtread'
import type { Task } from '../integrations/jobtread'
import { updateEvent } from '../integrations/googleCalendar'
import { supabase } from '../db/client'

const TZ = 'America/Los_Angeles'

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function dateDiffDays(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000)
}

export interface ShiftResult {
  deltaDays: number
  shiftedTasks: number
  shiftedEvents: number
}

// When a PM reports a delay, cascade-shift Gantt tasks starting from the delayed stage.
// Only downstream tasks that are actually blocked (predecessor's new end overlaps their start)
// are shifted — tasks with enough buffer to absorb the delay are left alone.
export async function shiftJobGantt(jobId: string, newCompletionDate: string, stage?: string): Promise<ShiftResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newCompletionDate) || isNaN(Date.parse(newCompletionDate))) {
    return { deltaDays: 0, shiftedTasks: 0, shiftedEvents: 0 }
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
  const tasks = await getJobTasks(jobId)
  const taskMap = new Map<string, Task>(tasks.map(t => [t.id, t]))

  const futureTasks = tasks.filter(t => t.endDate != null && t.endDate >= today)
  if (futureTasks.length === 0) return { deltaDays: 0, shiftedTasks: 0, shiftedEvents: 0 }

  // Anchor the delta to the stage being delayed
  const keywords = stage ? (STAGE_TASK_KEYWORDS[stage] ?? []) : []
  const stageTasks = keywords.length > 0
    ? futureTasks.filter(t => keywords.some(kw => t.name.toLowerCase().includes(kw)))
    : []
  const anchorTasks = stageTasks.length > 0 ? stageTasks : futureTasks

  anchorTasks.sort((a, b) => a.endDate!.localeCompare(b.endDate!))
  const currentStageEnd = anchorTasks[0].endDate!

  const deltaDays = Math.round(
    (new Date(newCompletionDate).getTime() - new Date(currentStageEnd).getTime())
    / (1000 * 60 * 60 * 24),
  )

  if (deltaDays <= 0) return { deltaDays, shiftedTasks: 0, shiftedEvents: 0 }

  // BFS through dependency graph — only shift a downstream task if the predecessor's
  // new end date actually overlaps with its start date (eats into its buffer).
  const taskUpdates = new Map<string, { newStart: string | null; newEnd: string }>()
  const queue: Array<{ task: Task; shiftDays: number }> = anchorTasks.map(t => ({ task: t, shiftDays: deltaDays }))
  const visited = new Set<string>()

  while (queue.length > 0) {
    const { task, shiftDays } = queue.shift()!
    if (visited.has(task.id)) continue
    visited.add(task.id)
    if (!task.endDate) continue

    const newEnd = addDays(task.endDate, shiftDays)
    const newStart = task.startDate && task.startDate >= today
      ? addDays(task.startDate, shiftDays)
      : task.startDate ?? null

    taskUpdates.set(task.id, { newStart, newEnd })

    for (const dep of task.dependentTasks) {
      if (visited.has(dep.id) || !dep.startDate) continue

      // How many days does the predecessor's new end overlap with the dependent's start?
      // If newEnd is 09-03 and dep starts 09-04, no overlap — dep stays put.
      // If newEnd is 09-04 and dep starts 09-04, dep must move to 09-05 (1 day shift).
      // Formula: depShift = (newEnd - dep.startDate) + 1, applied only when positive.
      const depShift = dateDiffDays(dep.startDate, newEnd) + 1
      if (depShift <= 0) continue

      const depTask = taskMap.get(dep.id)
      if (depTask) queue.push({ task: depTask, shiftDays: depShift })
    }
  }

  // Apply Jobtread updates
  for (const [taskId, { newStart, newEnd }] of taskUpdates) {
    const task = taskMap.get(taskId)!
    const input: Parameters<typeof updateTask>[1] = { endDate: newEnd }
    if (newStart !== task.startDate) input.startDate = newStart ?? undefined
    await updateTask(taskId, input)
  }

  // Sync Google Calendar events for shifted tasks
  const { data: syncRows } = await supabase
    .from('calendar_sync')
    .select('jobtread_task_id, google_event_id')
    .in('jobtread_task_id', [...taskUpdates.keys()])

  let shiftedEvents = 0
  for (const row of syncRows ?? []) {
    const update = taskUpdates.get(row.jobtread_task_id)
    if (!update) continue

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

  return { deltaDays, shiftedTasks: taskUpdates.size, shiftedEvents }
}
