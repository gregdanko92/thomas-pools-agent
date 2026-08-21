import { withRetry } from '../lib/retry'

const PAVE_URL = 'https://api.jobtread.com/pave'

// Org-specific custom field that holds the pipeline stage (Sold, Excavation, Plaster, etc.)
const STAGE_FIELD_ID = '22PAqEaW5wPt'
const PM_FIELD_ID = '22PZNLLQSfgf'

export const STAGE_ORDER: string[] = [
  'Sold',
  'Engineering / Permitting',
  'Excavation',
  'Steel',
  'Plumbing / Electric',
  'Gunnite',
  'Coping / Tile',
  'Hardscape / Landscape',
  'Fence & Gate',
  'Plaster',
]

export function nextStage(current: string): string | null {
  const idx = STAGE_ORDER.indexOf(current)
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null
  return STAGE_ORDER[idx + 1]
}

// Maps each pipeline stage to the Jobtread task name keywords used to identify its tasks.
export const STAGE_TASK_KEYWORDS: Record<string, string[]> = {
  'Sold': ['permit', 'plan', 'engineering'],
  'Engineering / Permitting': ['permit', 'engineering'],
  'Excavation': ['excavat'],
  'Steel': ['steel'],
  'Plumbing / Electric': ['plumbing', 'electric'],
  'Gunnite': ['gunite', 'gunnite'],
  'Coping / Tile': ['coping', 'tile'],
  'Hardscape / Landscape': ['hardscape', 'landscape'],
  'Fence & Gate': ['fence', 'gate'],
  'Plaster': ['plaster'],
}

function grantKey(): string {
  const key = process.env.JOBTREAD_GRANT_KEY?.trim()
  if (!key) throw new Error('JOBTREAD_GRANT_KEY is not set')
  return key
}

function orgId(): string {
  const id = process.env.JOBTREAD_ORG_ID?.trim()
  if (!id) throw new Error('JOBTREAD_ORG_ID is not set')
  return id
}

// --- Types ---

export interface Job {
  id: string
  name: string
  status: string
  stage: string | null
  pm: string | null
  createdAt: string | null
  closedOn: string | null
  location: JobLocation | null
}

export interface JobLocation {
  id: string
  name: string
  address: string | null
}

export interface JobDetail extends Job {
  tasks: Task[]
  documents: Document[]
  comments: Comment[]
}

export interface Task {
  id: string
  name: string
  isToDo: boolean
  startDate: string | null
  endDate: string | null
  account: TaskAccount | null
}

export interface TaskAccount {
  id: string
  name: string
}

export interface Document {
  id: string
  name: string
  type: string
  status: string
  price: number | null
  createdAt: string
}

export interface Comment {
  id: string
  message: string
  createdAt: string
  account: CommentAccount | null
}

export interface CommentAccount {
  id: string
  name: string
}

export interface UpdateJobInput {
  status?: string
  closedOn?: string
  name?: string
}

export interface UpdateTaskInput {
  startDate?: string
  endDate?: string
  name?: string
}

export interface CreateTaskInput {
  name: string
  startDate?: string
  endDate?: string
}

// --- Core ---

function extractCustomField(raw: Record<string, unknown>, fieldId: string): string | null {
  const cfv = raw.customFieldValues as { nodes: Array<{ value: string; customField: { id: string } }> } | undefined
  if (!cfv) return null
  return cfv.nodes.find(n => n.customField.id === fieldId)?.value || null
}

function extractStage(raw: Record<string, unknown>): string | null {
  return extractCustomField(raw, STAGE_FIELD_ID)
}

function extractPm(raw: Record<string, unknown>): string | null {
  return extractCustomField(raw, PM_FIELD_ID)
}

async function pave(query: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withRetry(async () => {
    const body = JSON.stringify({ query: { $: { grantKey: grantKey() }, ...query } })
    const res = await fetch(PAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Jobtread Pave request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`)
    }

    let json: Record<string, unknown>
    try {
      json = await res.json() as Record<string, unknown>
    } catch {
      throw new Error(`Jobtread Pave returned non-JSON response (status ${res.status})`)
    }

    const errors = json.errors as unknown[]
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`Jobtread Pave error: ${JSON.stringify(errors)}`)
    }

    return json
  })
}

function mapTask(t: Record<string, unknown>): Task {
  return {
    id: t.id as string,
    name: t.name as string,
    isToDo: t.isToDo as boolean,
    startDate: (t.startDate as string | null) ?? null,
    endDate: (t.endDate as string | null) ?? null,
    account: (t.account as TaskAccount | null) ?? null,
  }
}

// --- Query helpers ---

export interface ListJobsOptions {
  search?: string
  statuses?: string[]
  stages?: string[]
}

// Pave API returns at most 10 results per query with no cursor/pagination support.
// Strategy: query one prefix at a time (A-Z, 0-9). If a bucket returns exactly 10
// (the cap), it may be truncated — recurse into two-character sub-prefixes to
// recover the overflow. Dedup by ID across all results.
// Includes lowercase so sub-prefix expansion catches mixed-case names (e.g. title-case "Smith" → "Sm%")
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('')

// "Job N" placeholder names need separate treatment — space breaks the CHARS expansion.
// "Job 1%".."Job 9%" covers Job 1–9 and all multi-digit job numbers (Job 10, Job 104, etc.)
const JOB_N_PREFIXES = '0123456789'.split('').map(d => `Job ${d}`)
const PAVE_PAGE_SIZE = 10

async function fetchJobsWithPrefix(prefix: string): Promise<Job[]> {
  const jobsParam: Record<string, unknown> = {
    $: { where: ['name', 'like', `${prefix}%`] },
    nodes: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      closedOn: true,
      location: { id: true, name: true, address: true },
      customFieldValues: {
        nodes: { value: true, customField: { id: true } },
      },
    },
  }
  const data = await pave({ organization: { $: { id: orgId() }, jobs: jobsParam } })
  const org = data.organization as Record<string, unknown> | null
  if (!org) return []
  const rawNodes = (org.jobs as { nodes: Array<Record<string, unknown>> }).nodes ?? []
  return rawNodes.map(raw => ({ ...(raw as unknown as Job), stage: extractStage(raw), pm: extractPm(raw) }))
}

async function expandPrefix(prefix: string): Promise<Job[]> {
  const batch = await fetchJobsWithPrefix(prefix)
  if (batch.length < PAVE_PAGE_SIZE) return batch
  // Bucket hit the cap — expand into sub-prefixes to recover truncated results
  const subBatches = await Promise.allSettled(CHARS.map(c => expandPrefix(prefix + c)))
  const all = [...batch]
  for (const r of subBatches) {
    if (r.status === 'fulfilled') all.push(...r.value)
  }
  return all
}

async function listAllJobs(): Promise<Job[]> {
  const prefixes = [...CHARS, ...JOB_N_PREFIXES]
  const seen = new Set<string>()
  const all: Job[] = []

  // Run 5 prefix fetches at a time to avoid triggering Jobtread's rate limiter.
  // All 72 in parallel caused ETIMEDOUT blocks on Railway.
  const CONCURRENCY = 5
  for (let i = 0; i < prefixes.length; i += CONCURRENCY) {
    const results = await Promise.allSettled(prefixes.slice(i, i + CONCURRENCY).map(expandPrefix))
    for (const result of results) {
      if (result.status === 'rejected') continue
      for (const job of result.value) {
        if (!seen.has(job.id)) {
          seen.add(job.id)
          all.push(job)
        }
      }
    }
  }
  return all
}

export async function listJobs(options: ListJobsOptions = {}): Promise<Job[]> {
  const { search, statuses, stages } = options

  let allJobs: Job[]
  if (search) {
    const jobsParam: Record<string, unknown> = {
      $: { where: ['name', 'like', `%${search}%`] },
      nodes: {
        id: true, name: true, status: true, createdAt: true, closedOn: true,
        location: { id: true, name: true, address: true },
        customFieldValues: {
          nodes: { value: true, customField: { id: true } },
        },
      },
    }
    const data = await pave({ organization: { $: { id: orgId() }, jobs: jobsParam } })
    const org = data.organization as Record<string, unknown> | null
    if (!org) throw new Error(`Jobtread organization not found — verify JOBTREAD_ORG_ID is correct`)
    const rawNodes = (org.jobs as { nodes: Array<Record<string, unknown>> }).nodes ?? []
    allJobs = rawNodes.map(raw => ({ ...(raw as unknown as Job), stage: extractStage(raw), pm: extractPm(raw) }))
  } else {
    allJobs = await listAllJobs()
  }

  if (statuses?.length) {
    allJobs = allJobs.filter(j => statuses.includes(j.status))
  }
  if (stages?.length) {
    allJobs = allJobs.filter(j => j.stage !== null && stages.includes(j.stage))
  }
  return allJobs
}

export async function getJob(jobId: string): Promise<JobDetail> {
  const data = await pave({
    job: {
      $: { id: jobId },
      id: true,
      name: true,
      status: true,
      createdAt: true,
      closedOn: true,
      location: {
        id: true,
        name: true,
        address: true,
      },
      customFieldValues: {
        nodes: { value: true, customField: { id: true } },
      },
      tasks: {
        nodes: {
          id: true,
          name: true,
          isToDo: true,
          startDate: true,
          endDate: true,
          account: {
            id: true,
            name: true,
          },
        },
      },
      documents: {
        nodes: {
          id: true,
          name: true,
          type: true,
          status: true,
          price: true,
          createdAt: true,
        },
      },
      comments: {
        nodes: {
          id: true,
          message: true,
          createdAt: true,
          account: {
            id: true,
            name: true,
          },
        },
      },
    },
  })

  const raw = data.job as Record<string, unknown>

  const tasks = (raw.tasks as { nodes: Array<Record<string, unknown>> }).nodes.map(mapTask)

  const documents = (raw.documents as { nodes: Document[] }).nodes
  const comments = (raw.comments as { nodes: Comment[] }).nodes

  return {
    id: raw.id as string,
    name: raw.name as string,
    status: raw.status as string,
    stage: extractStage(raw),
    pm: extractPm(raw),
    createdAt: (raw.createdAt as string | null) ?? null,
    closedOn: (raw.closedOn as string | null) ?? null,
    location: (raw.location as JobLocation | null) ?? null,
    tasks,
    documents,
    comments,
  }
}

export async function getJobTasks(jobId: string): Promise<Task[]> {
  const data = await pave({
    job: {
      $: { id: jobId },
      tasks: {
        nodes: {
          id: true,
          name: true,
          isToDo: true,
          startDate: true,
          endDate: true,
          account: {
            id: true,
            name: true,
          },
        },
      },
    },
  })

  const job = data.job as Record<string, unknown>
  const tasks = job.tasks as { nodes: Array<Record<string, unknown>> }
  return tasks.nodes.map(mapTask)
}

export async function getJobDocuments(jobId: string): Promise<Document[]> {
  const data = await pave({
    job: {
      $: { id: jobId },
      documents: {
        nodes: {
          id: true,
          name: true,
          type: true,
          status: true,
          price: true,
          createdAt: true,
        },
      },
    },
  })

  const job = data.job as Record<string, unknown>
  return (job.documents as { nodes: Document[] }).nodes
}

export async function getJobComments(jobId: string): Promise<Comment[]> {
  const data = await pave({
    job: {
      $: { id: jobId },
      comments: {
        nodes: {
          id: true,
          message: true,
          createdAt: true,
          account: {
            id: true,
            name: true,
          },
        },
      },
    },
  })

  const job = data.job as Record<string, unknown>
  return (job.comments as { nodes: Comment[] }).nodes
}

// --- Mutation helpers ---

export async function createComment(jobId: string, message: string): Promise<Comment> {
  const data = await pave({
    createComment: {
      $: { input: { jobId, message } },
      id: true,
      message: true,
      createdAt: true,
      account: {
        id: true,
        name: true,
      },
    },
  })

  return data.createComment as Comment
}

export async function updateJob(jobId: string, input: UpdateJobInput): Promise<Job> {
  const data = await pave({
    updateJob: {
      $: { input: { id: jobId, ...input } },
      id: true,
      name: true,
      status: true,
      createdAt: true,
      closedOn: true,
      location: {
        id: true,
        name: true,
        address: true,
      },
    },
  })

  return data.updateJob as Job
}

export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<void> {
  await pave({
    updateTask: {
      $: { id: taskId, ...input },
    },
  })
}

export async function createTask(jobId: string, input: CreateTaskInput): Promise<Task> {
  const data = await pave({
    createTask: {
      $: { input: { jobId, ...input } },
      id: true,
      name: true,
      isToDo: true,
      startDate: true,
      endDate: true,
      account: {
        id: true,
        name: true,
      },
    },
  })

  return mapTask(data.createTask as Record<string, unknown>)
}
