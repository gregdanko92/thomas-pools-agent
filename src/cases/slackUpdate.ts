import { registerMessageListener, postMessage } from '../integrations/slack'
import { createComment } from '../integrations/jobtread'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'

// --- Types ---

export interface ProjectChannel {
  slackChannelId: string
  slackChannelName: string
  jobtreadJobId: string
  jobtreadJobName: string
}

export interface SlackUpdateResult {
  channelId: string
  jobtreadJobId: string
  jobtreadJobName: string
  extractedUpdate: string
  commentId: string
}

// --- Prompts ---

const EXTRACT_SYSTEM = `You are a construction project update extractor for Thomas Pools.
A team member posted a message in a Slack channel dedicated to a specific pool construction project.
Your job is to extract the key project update from their message and rewrite it as a clear, professional comment suitable for the project management system (Jobtread).

Rules:
- Write in third person or as a neutral update (not as the author)
- Preserve all specific details: dates, names, materials, measurements, issues, next steps
- Remove Slack-specific noise: @mentions, emoji, casual filler words
- Keep it under 200 words
- If the message contains no meaningful project update (e.g. it is a greeting, a question with no status info, or completely off-topic), reply with exactly: NO_UPDATE`

function buildExtractPrompt(message: string, jobName: string, channelName: string): string {
  return `Project: ${jobName}
Slack channel: #${channelName}
Message: ${message}

Extract the project update for the Jobtread comment.`
}

// --- Core ---

async function lookupChannel(channelId: string): Promise<ProjectChannel | null> {
  const { data, error } = await supabase
    .from('project_channels')
    .select('slack_channel_id, slack_channel_name, jobtread_job_id, jobtread_job_name')
    .eq('slack_channel_id', channelId)
    .maybeSingle()

  if (error) throw new Error(`project_channels lookup failed: ${error.message}`)
  if (!data) return null

  return {
    slackChannelId: data.slack_channel_id as string,
    slackChannelName: data.slack_channel_name as string,
    jobtreadJobId: data.jobtread_job_id as string,
    jobtreadJobName: data.jobtread_job_name as string,
  }
}

export async function handleSlackUpdate(
  channelId: string,
  messageText: string,
): Promise<SlackUpdateResult | null> {
  const channel = await lookupChannel(channelId)
  if (!channel) return null

  const extractedUpdate = await complete(
    buildExtractPrompt(messageText, channel.jobtreadJobName, channel.slackChannelName),
    { system: EXTRACT_SYSTEM },
  )

  const trimmed = extractedUpdate.trim()
  if (!trimmed || trimmed.toUpperCase() === 'NO_UPDATE') {
    supabase.from('agent_run_log').insert({
      run_type: 'slack_update',
      jobtread_job_id: channel.jobtreadJobId,
      details: { channelId, reason: 'no_meaningful_update', messagePreview: messageText.slice(0, 100) },
      success: true,
    }).then(() => undefined, () => undefined)
    return null
  }

  const comment = await createComment(channel.jobtreadJobId, trimmed)

  supabase.from('agent_run_log').insert({
    run_type: 'slack_update',
    jobtread_job_id: channel.jobtreadJobId,
    details: {
      channelId,
      commentId: comment.id,
      messagePreview: messageText.slice(0, 100),
    },
    success: true,
  }).then(() => undefined, () => undefined)

  return {
    channelId,
    jobtreadJobId: channel.jobtreadJobId,
    jobtreadJobName: channel.jobtreadJobName,
    extractedUpdate: trimmed,
    commentId: comment.id,
  }
}

// --- Slack listener registration ---

export function registerSlackUpdateListener(): void {
  // Listen to every message in every channel the bot is in.
  // Filters out bot messages and messages with no text.
  // project_channels lookup is the gate that restricts processing to mapped channels only.
  registerMessageListener(/[\s\S]+/, async ({ message }) => {
    const msg = message as unknown as Record<string, unknown>

    // Ignore bot messages, message edits, and subtype events (joins, leaves, etc.)
    if (msg.bot_id || msg.subtype || !msg.text || typeof msg.text !== 'string') return

    const channelId = msg.channel as string | undefined
    const text = msg.text.trim()

    if (!channelId || !text) return

    try {
      const result = await handleSlackUpdate(channelId, text)

      if (result) {
        await postMessage(
          channelId,
          `Update logged to Jobtread for *${result.jobtreadJobName}*. ✓`,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)

      await supabase.from('agent_run_log').insert({
        run_type: 'slack_update',
        details: { channelId, error: errMsg, messagePreview: text.slice(0, 100) },
        success: false,
        error_message: errMsg,
      }).then(() => undefined, () => undefined)
    }
  })
}
