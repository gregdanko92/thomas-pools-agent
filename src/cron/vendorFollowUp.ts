import cron from 'node-cron'
import { sendSms } from '../integrations/twilio'
import { postMessage } from '../integrations/slack'
import { supabase } from '../db/client'

const TZ = 'America/Los_Angeles'
const HOURS_24 = 24 * 60 * 60 * 1000
const HOURS_48 = 48 * 60 * 60 * 1000

// --- Types ---

export interface OutreachRow {
  id: string
  vendor_id: string
  jobtread_job_id: string
  message_sent: string
  sent_at: string
  status: string
  twilio_message_sid: string | null
  escalated_at: string | null
}

export interface VendorRow {
  id: string
  name: string
  phone: string
  trade: string | null
  jobtread_job_name: string | null
}

export interface FollowUpResult {
  repingedCount: number
  escalatedCount: number
  errors: string[]
}

// --- Core logic ---

export async function runVendorFollowUp(): Promise<FollowUpResult> {
  const result: FollowUpResult = { repingedCount: 0, escalatedCount: 0, errors: [] }

  const pmChannel = process.env.SLACK_PM_ALERTS_CHANNEL
  if (!pmChannel) throw new Error('SLACK_PM_ALERTS_CHANNEL is not set')

  const now = Date.now()
  const cutoff24h = new Date(now - HOURS_24).toISOString()
  const cutoff48h = new Date(now - HOURS_48).toISOString()

  // Load all pending rows — status 'sent' (initial, no follow-up yet) and 'followed_up' (re-pinged, awaiting escalation).
  const { data: pendingRows, error: fetchError } = await supabase
    .from('outreach_log')
    .select('id, vendor_id, jobtread_job_id, message_sent, sent_at, status, twilio_message_sid, escalated_at')
    .in('status', ['sent', 'followed_up'])
    .lt('sent_at', cutoff24h)

  if (fetchError) throw new Error(`Failed to fetch outreach_log: ${fetchError.message}`)
  if (!pendingRows || pendingRows.length === 0) return result

  // Fetch vendor details for all affected vendor IDs in one query.
  const vendorIds = [...new Set((pendingRows as OutreachRow[]).map(r => r.vendor_id))]
  const { data: vendorRows, error: vendorError } = await supabase
    .from('vendors')
    .select('id, name, phone, trade, jobtread_job_name')
    .in('id', vendorIds)

  if (vendorError) throw new Error(`Failed to fetch vendors: ${vendorError.message}`)
  const vendorMap = new Map<string, VendorRow>((vendorRows as VendorRow[]).map(v => [v.id, v]))

  for (const row of pendingRows as OutreachRow[]) {
    const vendor = vendorMap.get(row.vendor_id)
    if (!vendor) {
      result.errors.push(`Vendor ${row.vendor_id} not found for outreach row ${row.id}`)
      continue
    }

    const sentAt = new Date(row.sent_at).getTime()
    const age = now - sentAt

    try {
      if (row.status === 'sent' && age >= HOURS_24 && age < HOURS_48) {
        await sendRepingAndMark(row, vendor, result)
      } else if (age >= HOURS_48 && row.status !== 'escalated') {
        await escalateToPm(row, vendor, pmChannel, result)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Row ${row.id} (vendor ${vendor.name}): ${msg}`)
    }
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'vendor_follow_up',
    details: result,
    success: result.errors.length === 0,
    error_message: result.errors.length > 0 ? result.errors.join('; ') : null,
  }).then(() => undefined, () => undefined)

  return result
}

async function sendRepingAndMark(
  row: OutreachRow,
  vendor: VendorRow,
  result: FollowUpResult,
): Promise<void> {
  const jobLabel = vendor.jobtread_job_name ?? row.jobtread_job_id
  const followUpText =
    `Hi ${vendor.name}, just following up on the Thomas Pools job: ${jobLabel}. ` +
    `Please reply to confirm your availability. Thanks!`

  await sendSms(vendor.phone, followUpText)

  await supabase
    .from('outreach_log')
    .update({ status: 'followed_up' })
    .eq('id', row.id)

  result.repingedCount++
}

async function escalateToPm(
  row: OutreachRow,
  vendor: VendorRow,
  pmChannel: string,
  result: FollowUpResult,
): Promise<void> {
  const jobLabel = vendor.jobtread_job_name ?? row.jobtread_job_id
  const trade = vendor.trade ? ` (${vendor.trade})` : ''
  const sentDate = new Date(row.sent_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: TZ,
  })

  const message =
    `*Vendor not responding — action needed*\n` +
    `Vendor: *${vendor.name}*${trade}\n` +
    `Phone: ${vendor.phone}\n` +
    `Job: ${jobLabel}\n` +
    `First contacted: ${sentDate} (48+ hours ago, no reply)\n` +
    `Original message: "${row.message_sent}"\n` +
    `Please follow up directly or find an alternate vendor.`

  await postMessage(pmChannel, message)

  await supabase
    .from('outreach_log')
    .update({ status: 'escalated', escalated_at: new Date().toISOString() })
    .eq('id', row.id)

  result.escalatedCount++
}

// --- Cron schedule ---

// Runs every hour so follow-ups and escalations trigger as close to the 24/48h marks as possible.
export function startVendorFollowUp(): void {
  cron.schedule('0 * * * *', () => {
    runVendorFollowUp().catch(err =>
      console.error('[vendor-follow-up]', err instanceof Error ? err.message : err),
    )
  }, { timezone: TZ })
}
