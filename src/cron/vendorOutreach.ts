import cron from 'node-cron'
import { sendSms } from '../integrations/twilio'
import { supabase } from '../db/client'

const TZ = 'America/Los_Angeles'

// Vendors who haven't been contacted in this many days are due for outreach.
const OUTREACH_INTERVAL_DAYS = 3

export interface OutreachCandidate {
  vendorId: string
  vendorName: string
  phone: string
  trade: string | null
  jobtreadJobId: string
  jobtreadJobName: string
}

export interface OutreachResult {
  vendorId: string
  vendorName: string
  sent: boolean
  twilioSid?: string
  error?: string
}

function buildSmsBody(candidate: OutreachCandidate): string {
  const trade = candidate.trade ? ` (${candidate.trade})` : ''
  return (
    `Hi ${candidate.vendorName}${trade} — this is a check-in from Thomas Pools regarding ` +
    `the ${candidate.jobtreadJobName} project. Can you share a quick status update? Reply to this message.`
  )
}

async function fetchCandidates(): Promise<OutreachCandidate[]> {
  const { data: vendors, error: vendorErr } = await supabase
    .from('vendors')
    .select('id, name, phone, trade, jobtread_job_id, jobtread_job_name')
    .eq('active', true)
    .not('jobtread_job_id', 'is', null)

  if (vendorErr) throw new Error(`Failed to fetch vendors: ${vendorErr.message}`)
  if (!vendors || vendors.length === 0) return []

  const cutoff = new Date(Date.now() - OUTREACH_INTERVAL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const candidates: OutreachCandidate[] = []

  for (const vendor of vendors) {
    // Find the most recent outreach log entry for this vendor that is in a
    // terminal/active state — sent, replied, or escalated all count as "contacted".
    const { data: recent, error: logErr } = await supabase
      .from('outreach_log')
      .select('sent_at, status')
      .eq('vendor_id', vendor.id)
      .order('sent_at', { ascending: false })
      .limit(1)

    if (logErr) {
      console.error(`[vendor-outreach] Failed to query log for vendor ${vendor.id}:`, logErr.message)
      continue
    }

    const lastEntry = recent?.[0]

    // Skip vendors who received outreach recently and haven't had time to respond.
    if (lastEntry && lastEntry.sent_at > cutoff) continue

    candidates.push({
      vendorId: vendor.id,
      vendorName: vendor.name,
      phone: vendor.phone,
      trade: vendor.trade ?? null,
      jobtreadJobId: vendor.jobtread_job_id,
      jobtreadJobName: vendor.jobtread_job_name,
    })
  }

  return candidates
}

export async function runVendorOutreach(): Promise<OutreachResult[]> {
  const results: OutreachResult[] = []
  let candidateCount = 0
  let sentCount = 0

  try {
    const candidates = await fetchCandidates()
    candidateCount = candidates.length

    for (const candidate of candidates) {
      const body = buildSmsBody(candidate)
      try {
        const smsResult = await sendSms(candidate.phone, body)

        await supabase.from('outreach_log').insert({
          vendor_id: candidate.vendorId,
          jobtread_job_id: candidate.jobtreadJobId,
          message_sent: body,
          status: 'sent',
          twilio_message_sid: smsResult.sid,
        })

        results.push({ vendorId: candidate.vendorId, vendorName: candidate.vendorName, sent: true, twilioSid: smsResult.sid })
        sentCount++
      } catch (smsErr) {
        const errMsg = smsErr instanceof Error ? smsErr.message : String(smsErr)
        console.error(`[vendor-outreach] Failed to send SMS to ${candidate.vendorName}:`, errMsg)

        await supabase.from('outreach_log').insert({
          vendor_id: candidate.vendorId,
          jobtread_job_id: candidate.jobtreadJobId,
          message_sent: body,
          status: 'failed',
          twilio_message_sid: null,
        }).then(() => undefined, () => undefined)

        results.push({ vendorId: candidate.vendorId, vendorName: candidate.vendorName, sent: false, error: errMsg })
      }
    }

    await supabase.from('agent_run_log').insert({
      run_type: 'vendor_outreach',
      details: { candidateCount, sentCount, failedCount: candidateCount - sentCount },
      success: true,
    }).then(() => undefined, () => undefined)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)

    await supabase.from('agent_run_log').insert({
      run_type: 'vendor_outreach',
      details: { candidateCount },
      success: false,
      error_message: errMsg,
    }).then(() => undefined, () => undefined)

    throw err
  }

  return results
}

// Fires daily at 9 AM America/Los_Angeles — early enough to catch vendors before noon.
export function startVendorOutreach(): void {
  cron.schedule('0 9 * * *', () => {
    runVendorOutreach().catch(err =>
      console.error('[vendor-outreach]', err instanceof Error ? err.message : err),
    )
  }, { timezone: TZ })
}
