import { App, LogLevel } from '@slack/bolt'
import { withRetry } from '../lib/retry'
import type {
  Middleware,
  SlackCommandMiddlewareArgs,
  SlackEventMiddlewareArgs,
  StringIndexed,
} from '@slack/bolt'
import type { KnownBlock, Block } from '@slack/types'

export type { KnownBlock, Block }
export type SlashCommandHandler = Middleware<SlackCommandMiddlewareArgs>
export type MessageHandler = Middleware<SlackEventMiddlewareArgs<'message'> & StringIndexed>

function botToken(): string {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set')
  return token
}

function appToken(): string {
  const token = process.env.SLACK_APP_TOKEN
  if (!token) throw new Error('SLACK_APP_TOKEN is not set')
  return token
}

let _app: App | null = null

export function getApp(): App {
  if (!_app) {
    _app = new App({
      token: botToken(),
      appToken: appToken(),
      socketMode: true,
      logLevel: LogLevel.WARN,
    })
  }
  return _app
}

export async function postMessage(channel: string, text: string): Promise<void> {
  await withRetry(() => getApp().client.chat.postMessage({ channel, text }))
}

// Returns the message timestamp (ts), which serves as thread_ts for replies
export async function postMessageWithTs(channel: string, text: string): Promise<string> {
  const res = await withRetry(() => getApp().client.chat.postMessage({ channel, text }))
  const ts = res.ts
  if (!ts) throw new Error('Slack postMessage returned no ts')
  return ts
}

export async function postInThread(channel: string, threadTs: string, text: string): Promise<void> {
  await withRetry(() => getApp().client.chat.postMessage({ channel, thread_ts: threadTs, text }))
}

export async function postBlocks(
  channel: string,
  blocks: (KnownBlock | Block)[],
  fallbackText: string,
): Promise<void> {
  await withRetry(() => getApp().client.chat.postMessage({ channel, blocks, text: fallbackText }))
}

let _userCache: Map<string, string> | null = null

// Looks up a Slack user ID by display name or real name (case-insensitive). Returns null if not found.
export async function lookupUserByName(name: string): Promise<string | null> {
  if (!_userCache) {
    _userCache = new Map()
    let cursor: string | undefined
    do {
      const res = await withRetry(() =>
        getApp().client.users.list({ limit: 200, cursor }),
      )
      for (const member of res.members ?? []) {
        if (member.deleted || member.is_bot) continue
        const display = member.profile?.display_name?.toLowerCase() ?? ''
        const real = member.profile?.real_name?.toLowerCase() ?? ''
        if (display) _userCache!.set(display, member.id!)
        if (real && real !== display) _userCache!.set(real, member.id!)
      }
      cursor = res.response_metadata?.next_cursor || undefined
    } while (cursor)
  }

  const lower = name.toLowerCase()
  if (_userCache.has(lower)) return _userCache.get(lower)!

  // Partial match — first name only (e.g. "Reagan" matches "Reagan Smith")
  for (const [key, id] of _userCache) {
    if (key.startsWith(lower) || key.includes(lower)) return id
  }

  return null
}

export function registerSlashCommand(command: string, handler: SlashCommandHandler): void {
  getApp().command(command, handler)
}

export function registerMessageListener(
  pattern: string | RegExp,
  handler: MessageHandler,
): void {
  getApp().message(pattern, handler)
}

export async function startSlackApp(): Promise<void> {
  await getApp().start()
}

export async function stopSlackApp(): Promise<void> {
  await getApp().stop()
}
