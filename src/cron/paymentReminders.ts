import cron from 'node-cron'
import { getJobDocuments } from '../integrations/jobtread'
import type { Document } from '../integrations/jobtread'
import { postMessage } from '../integrations/slack'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'
import { withLock } from '../lib/cronLock'

const TZ = 'America/Los_Angeles'

// Jobtread document statuses that indicate a payment has been collected (lowercased for case-insensitive match).
// Exact values depend on org configuration — verify against live data and adjust.
const PAID_STATUSES = new Set(['paid', 'collected', 'approved'])

// Days between repeat Slack alerts for the same uncollected milestone.
const RENOTIFY_DAYS = 7

export interface PaymentReminderResult {
  collected: number
  alerted: number
  errors: number
}

interface ScheduleRow {
  id: string
  jobtread_job_id: string
  jobtread_job_name: string
  milestone_name: string
  amount: number
  notified: boolean
  notified_at: string | null
}

function isPaid(doc: Document, amount: number): boolean {
  return (
    PAID_STATUSES.has(doc.status.toLowerCase()) &&
    doc.price !== null &&
    Math.abs(doc.price - amount) < 0.01
  )
}

function formatUsd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

async function processJobSchedules(
  jobSchedules: ScheduleRow[],
  docs: Document[],
  channel: string,
  renotifyCutoff: string,
): Promise<{ collected: number; alerted: number; errors: number }> {
  let collected = 0
  let alerted = 0
  let errors = 0

  for (const schedule of jobSchedules) {
    try {
      const amount = Number(schedule.amount)
      const paidDoc = docs.find(d => isPaid(d, amount))

      if (paidDoc) {
        const { error: updateErr } = await supabase
          .from('payment_schedules')
          .update({ collected: true, collected_at: new Date().toISOString() })
          .eq('id', schedule.id)

        if (updateErr) {
          console.error(`[payment-reminders] Failed to mark ${schedule.milestone_name} as collected:`, updateErr.message)
          errors++
        } else {
          collected++
        }
        continue
      }

      // notified_at=null with notified=true means a prior write was partial — treat as un-notified.
      const shouldNotify =
        !schedule.notified || schedule.notified_at === null || schedule.notified_at < renotifyCutoff

      if (shouldNotify) {
        const msg =
          `*Payment reminder:* ${schedule.jobtread_job_name} — ` +
          `*${schedule.milestone_name}* (${formatUsd(amount)}) has not been collected.`
        await postMessage(channel, msg)

        const { error: updateErr } = await supabase
          .from('payment_schedules')
          .update({ notified: true, notified_at: new Date().toISOString() })
          .eq('id', schedule.id)

        if (updateErr) {
          // Slack message was sent — log but don't count as error; next run will resend but that's safer than silence.
          console.error(`[payment-reminders] Failed to mark ${schedule.milestone_name} as notified:`, updateErr.message)
        }

        alerted++
      }
    } catch (err) {
      console.error(
        `[payment-reminders] Failed to process milestone ${schedule.milestone_name}:`,
        err instanceof Error ? err.message : err,
      )
      errors++
    }
  }

  return { collected, alerted, errors }
}

export async function runPaymentReminders(): Promise<PaymentReminderResult> {
  let collected = 0
  let alerted = 0
  let errors = 0

  const channel = process.env.SLACK_PAYMENT_CHANNEL
  if (!channel) throw new Error('SLACK_PAYMENT_CHANNEL is not set')

  const { data: schedules, error: schedErr } = await supabase
    .from('payment_schedules')
    .select('id, jobtread_job_id, jobtread_job_name, milestone_name, amount, notified, notified_at')
    .eq('collected', false)

  if (schedErr) throw new Error(`Failed to fetch payment schedules: ${schedErr.message}`)
  if (!schedules || schedules.length === 0) return { collected: 0, alerted: 0, errors: 0 }

  // Group by job to fetch documents once per job instead of once per milestone
  const byJob = new Map<string, ScheduleRow[]>()
  for (const s of schedules as ScheduleRow[]) {
    const group = byJob.get(s.jobtread_job_id) ?? []
    group.push(s)
    byJob.set(s.jobtread_job_id, group)
  }

  const renotifyCutoff = new Date(Date.now() - RENOTIFY_DAYS * 24 * 60 * 60 * 1000).toISOString()

  for (const [jobId, jobSchedules] of byJob) {
    try {
      const docs = await getJobDocuments(jobId)
      const result = await processJobSchedules(jobSchedules, docs, channel, renotifyCutoff)
      collected += result.collected
      alerted += result.alerted
      errors += result.errors
    } catch (err) {
      console.error(
        `[payment-reminders] Failed to fetch documents for job ${jobId}:`,
        err instanceof Error ? err.message : err,
      )
      errors += jobSchedules.length
    }
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'payment_check',
    details: { collected, alerted, errors, totalUncollected: schedules.length - collected },
    success: errors === 0,
  }).then(() => undefined, () => undefined)

  return { collected, alerted, errors }
}

// Fires daily at 8 AM America/Los_Angeles — early enough for the team to act during business hours.
export function startPaymentReminders(): void {
  cron.schedule('0 8 * * *', () => {
    withLock('payment-reminders', () => runPaymentReminders()).catch(async err => {
      console.error('[payment-reminders]', err instanceof Error ? err.message : err)
      await postErrorAlert('payment-reminders', err)
    })
  }, { timezone: TZ })
}
