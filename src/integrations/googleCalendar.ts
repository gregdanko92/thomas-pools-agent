import { google } from 'googleapis'
import type { calendar_v3 } from 'googleapis'

// --- Types ---

export interface CalendarEvent {
  id: string
  title: string
  description: string | null
  location: string | null
  start: string
  end: string
  htmlLink: string | null
}

export interface CreateEventInput {
  title: string
  start: string
  end: string
  description?: string
  location?: string
}

export interface UpdateEventInput {
  title?: string
  start?: string
  end?: string
  description?: string
  location?: string
}

export interface ListEventsOptions {
  timeMin?: string
  timeMax?: string
  maxResults?: number
}

// --- Env ---

function clientEmail(): string {
  const email = process.env.GOOGLE_CLIENT_EMAIL
  if (!email?.trim()) throw new Error('GOOGLE_CLIENT_EMAIL is not set')
  return email
}

function privateKey(): string {
  const key = process.env.GOOGLE_PRIVATE_KEY
  if (!key?.trim()) throw new Error('GOOGLE_PRIVATE_KEY is not set')
  // Normalize line endings: strip \r first, then convert literal \n sequences to real newlines
  return key.replace(/\r/g, '').replace(/\\n/g, '\n')
}

function calendarId(): string {
  const id = process.env.GOOGLE_CALENDAR_ID
  if (!id?.trim()) throw new Error('GOOGLE_CALENDAR_ID is not set')
  return id
}

// --- Client ---

let _calendar: calendar_v3.Calendar | null = null

function getClient(): calendar_v3.Calendar {
  if (!_calendar) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: clientEmail(),
        private_key: privateKey(),
      },
      scopes: ['https://www.googleapis.com/auth/calendar'],
    })
    _calendar = google.calendar({ version: 'v3', auth })
  }
  return _calendar
}

function mapEvent(raw: calendar_v3.Schema$Event): CalendarEvent {
  if (!raw.id) throw new Error('Calendar event missing id')
  const start = raw.start?.dateTime ?? raw.start?.date
  const end = raw.end?.dateTime ?? raw.end?.date
  if (!start) throw new Error(`Calendar event ${raw.id} missing start`)
  if (!end) throw new Error(`Calendar event ${raw.id} missing end`)
  return {
    id: raw.id,
    title: raw.summary ?? '',
    description: raw.description ?? null,
    location: raw.location ?? null,
    start,
    end,
    htmlLink: raw.htmlLink ?? null,
  }
}

// Returns { date } for bare date strings (YYYY-MM-DD) and { dateTime, timeZone } for full ISO strings.
// Google Calendar rejects date-only strings sent as dateTime, and all-day events must use date.
function toGoogleDateTime(iso: string): calendar_v3.Schema$EventDateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { date: iso }
  }
  return { dateTime: iso, timeZone: 'UTC' }
}

// --- Exported helpers ---

export async function createEvent(input: CreateEventInput): Promise<CalendarEvent> {
  const res = await getClient().events.insert({
    calendarId: calendarId(),
    requestBody: {
      summary: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      start: toGoogleDateTime(input.start),
      end: toGoogleDateTime(input.end),
    },
  })
  return mapEvent(res.data)
}

export async function updateEvent(
  eventId: string,
  input: UpdateEventInput,
): Promise<CalendarEvent> {
  const calId = calendarId()
  const patch: calendar_v3.Schema$Event = {}
  if (input.title !== undefined) patch.summary = input.title
  if (input.description !== undefined) patch.description = input.description
  if (input.location !== undefined) patch.location = input.location
  if (input.start !== undefined) patch.start = toGoogleDateTime(input.start)
  if (input.end !== undefined) patch.end = toGoogleDateTime(input.end)
  const res = await getClient().events.patch({
    calendarId: calId,
    eventId,
    requestBody: patch,
  })
  return mapEvent(res.data)
}

export async function deleteEvent(eventId: string): Promise<void> {
  await getClient().events.delete({
    calendarId: calendarId(),
    eventId,
  })
}

export async function getEvent(eventId: string): Promise<CalendarEvent> {
  const res = await getClient().events.get({
    calendarId: calendarId(),
    eventId,
  })
  return mapEvent(res.data)
}

export async function listEvents(options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
  const client = getClient()
  const calId = calendarId()
  const maxResults = options.maxResults ?? 250
  const events: CalendarEvent[] = []
  let pageToken: string | undefined

  do {
    const res = await client.events.list({
      calendarId: calId,
      timeMin: options.timeMin,
      timeMax: options.timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    })
    for (const item of res.data.items ?? []) {
      events.push(mapEvent(item))
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken !== undefined)

  return events
}
