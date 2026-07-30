import { App, LogLevel } from '@slack/bolt'
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
  await getApp().client.chat.postMessage({ channel, text })
}

export async function postBlocks(
  channel: string,
  blocks: (KnownBlock | Block)[],
  fallbackText: string,
): Promise<void> {
  await getApp().client.chat.postMessage({ channel, blocks, text: fallbackText })
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
