// Per-job "unique requirements": inspections a job needs only when a Jobtread job field
// says so (Soils Report, Grading Permit, Retaining Wall Permit). Each one is reminded
// from one Status and must be complete by a later Status.

// Boolean job custom fields (Yes/No dropdowns in the Jobtread UI, booleans in the API).
export const SOILS_REPORT_FIELD_ID = '22Pfycan8fKa'
export const GRADING_PERMIT_FIELD_ID = '22PfyccGauvh'
export const RETAINING_WALL_PERMIT_FIELD_ID = '22PfycdgZn8w'

export const REQUIREMENT_FIELD_IDS = [SOILS_REPORT_FIELD_ID, GRADING_PERMIT_FIELD_ID, RETAINING_WALL_PERMIT_FIELD_ID]

// The full option order of the job Status field (22PAqEaW5wPt), as returned by Jobtread.
// Unlike STAGE_ORDER in jobtread.ts this includes every option, so a job already past a
// reminder stage (e.g. in Final or Heater Reconnection) still compares correctly.
export const STATUS_OPTION_ORDER: string[] = [
  'New Lead',
  'Estimating',
  'First Visit Complete',
  'Sold',
  'On Hold',
  'Engineering / Permitting',
  'Demo (Remodels Only)',
  'Excavation',
  'Steel',
  'Plumbing / Electric',
  'Gunnite',
  'Coping / Tile',
  'Hardscape',
  'Fence & Gate',
  'Plaster',
  'Final',
  'Heater Reconnection',
  'Landscape/Touch-Ups/Front Yard',
  'Completed',
  'Lost',
]

// Jobs in these statuses get no requirement reminders.
export const REQUIREMENT_INACTIVE_STATUSES = new Set(['On Hold', 'Completed', 'Lost'])

export interface Requirement {
  key: string
  fieldId: string
  fieldName: string
  taskName: string
  remindFrom: string
  dueBy: string
}

export const REQUIREMENTS: Requirement[] = [
  { key: 'soils_inspection', fieldId: SOILS_REPORT_FIELD_ID, fieldName: 'Soils Report', taskName: 'Soils Inspection', remindFrom: 'Excavation', dueBy: 'Steel' },
  { key: 'initial_grading_inspection', fieldId: GRADING_PERMIT_FIELD_ID, fieldName: 'Grading Permit', taskName: 'Initial Grading Inspection', remindFrom: 'Excavation', dueBy: 'Steel' },
  { key: 'grading_final_inspection', fieldId: GRADING_PERMIT_FIELD_ID, fieldName: 'Grading Permit', taskName: 'Grading Final Inspection', remindFrom: 'Plaster', dueBy: 'Final' },
  { key: 'footing_inspection', fieldId: RETAINING_WALL_PERMIT_FIELD_ID, fieldName: 'Retaining Wall Permit', taskName: 'Footing Inspection', remindFrom: 'Gunnite', dueBy: 'Hardscape' },
  { key: 'masonry_inspection', fieldId: RETAINING_WALL_PERMIT_FIELD_ID, fieldName: 'Retaining Wall Permit', taskName: 'Masonry Inspection', remindFrom: 'Hardscape', dueBy: 'Plaster' },
  { key: 'drainage_inspection', fieldId: RETAINING_WALL_PERMIT_FIELD_ID, fieldName: 'Retaining Wall Permit', taskName: 'Drainage Inspection', remindFrom: 'Hardscape', dueBy: 'Plaster' },
]

export function requirementByKey(key: string): Requirement | undefined {
  return REQUIREMENTS.find(r => r.key === key)
}

// -1 when the status isn't a known option (treated as "not reached").
export function statusIndex(status: string | null): number {
  return status ? STATUS_OPTION_ORDER.indexOf(status) : -1
}

export function isAtOrPast(status: string | null, target: string): boolean {
  const idx = statusIndex(status)
  return idx !== -1 && idx >= STATUS_OPTION_ORDER.indexOf(target)
}

// --- Task name matching ---
// Hand-added tasks are matched conservatively: the task must contain every word of the
// requirement name (in any order, plus at most one extra word), or be within two typos of
// it. So "Form Deck + Drainage" never matches Drainage Inspection, and "Final inspect"
// never matches Grading Final Inspection.

const WORD_ALIASES: Record<string, string> = {
  inspect: 'inspection',
  inspections: 'inspection',
  insp: 'inspection',
  soil: 'soils',
}

function normalizeWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(w => WORD_ALIASES[w] ?? w)
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = above
    }
  }
  return prev[b.length]
}

export function matchesRequirementTask(taskName: string, requirement: Requirement): boolean {
  const taskWords = normalizeWords(taskName)
  const reqWords = normalizeWords(requirement.taskName)
  if (taskWords.join(' ') === reqWords.join(' ')) return true

  const taskSet = new Set(taskWords)
  if (reqWords.every(w => taskSet.has(w)) && taskWords.length <= reqWords.length + 1) return true

  return editDistance(taskName.toLowerCase().trim(), requirement.taskName.toLowerCase()) <= 2
}
