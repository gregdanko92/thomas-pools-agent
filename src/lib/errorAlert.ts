import { postMessage } from '../integrations/slack'

// Posts to SLACK_ERROR_CHANNEL when set. Silently no-ops if the env var is absent so the
// agent can start without the channel configured (e.g. local dev, early deploy).
// Inner .catch ensures a Slack failure never re-throws during an already-failing cron run.
export async function postErrorAlert(context: string, err: unknown): Promise<void> {
  const channel = process.env.SLACK_ERROR_CHANNEL
  if (!channel) return

  const msg = err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err)
  try {
    await postMessage(channel, `:rotating_light: *Agent error* [${context}]\n${msg}`)
  } catch {
    // silence — alerting must not cascade into an unhandled rejection
  }
}
