import Anthropic from '@anthropic-ai/sdk'

// --- Types ---

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | Anthropic.Messages.ContentBlockParam[]
}

export interface ChatOptions {
  model?: Anthropic.Messages.Model
  maxTokens?: number
  system?: string
}

// --- Env ---

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key?.trim()) throw new Error('ANTHROPIC_API_KEY is not set')
  return key
}

// --- Client ---

const DEFAULT_MODEL: Anthropic.Messages.Model = 'claude-opus-4-8'
const DEFAULT_MAX_TOKENS = 4096

let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: apiKey(), maxRetries: 3 })
  }
  return _client
}

function extractText(message: Anthropic.Message): string {
  const textBlock = message.content.find(
    (block): block is Anthropic.Messages.TextBlock => block.type === 'text',
  )
  if (!textBlock) {
    throw new Error(`Claude response contained no text block (stop_reason: ${message.stop_reason})`)
  }
  return textBlock.text
}

// --- Exported helpers ---

export async function complete(userPrompt: string, options: ChatOptions = {}): Promise<string> {
  return chat([{ role: 'user', content: userPrompt }], options)
}

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  if (messages.length === 0) throw new Error('messages must not be empty')
  const { model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, system } = options
  const message = await getClient()
    .messages.stream({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages,
    })
    .finalMessage()
  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Claude response truncated at ${maxTokens} tokens — increase maxTokens or shorten the prompt`)
  }
  return extractText(message)
}
