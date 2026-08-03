const PAVE_URL = 'https://api.jobtread.com/pave'

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

async function pave(query: Record<string, unknown>): Promise<Record<string, unknown>> {
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
}

export async function listJobs(options: ListJobsOptions = {}): Promise<Job[]> {
  const { search, statuses } = options
  const whereValue = search ? `%${search}%` : '%'

  const jobsParam: Record<string, unknown> = {
    $: { where: ['name', 'like', whereValue] },
    nodes: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      closedOn: true,
      location: { id: true, name: true, address: true },
    },
  }

  const data = await pave({
    organization: { $: { id: orgId() }, jobs: jobsParam },
  })

  const org = data.organization as Record<string, unknown> | null
  if (!org) throw new Error(`Jobtread organization not found — verify JOBTREAD_ORG_ID is correct`)

  const jobsResult = org.jobs as Record<string, unknown>
  console.log('[jobtread] organization.jobs keys:', Object.keys(jobsResult))

  const allJobs = (jobsResult.nodes as Job[]) ?? []

  if (statuses?.length) {
    return allJobs.filter(j => statuses.includes(j.status))
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

export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<Task> {
  const data = await pave({
    updateTask: {
      $: { input: { id: taskId, ...input } },
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

  return mapTask(data.updateTask as Record<string, unknown>)
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
