import cron from 'node-cron'
import { sendSms } from '../integrations/twilio'
import { supabase } from '../db/client'
import { postErrorAlert } from '../lib/errorAlert'

const TZ = 'America/Los_Angeles'

// C7: respect env override so this can be tuned per-environment without a deploy
const OUTREACH_INTERVAL_DAYS = Number(process.env.VENDOR_OUTREACH_INTERVAL_DAYS) || 3

export interface OutreachCandidate {
  vendorId: string
  vendorName: string
  phone: string
  trade: string | null
  jobtreadJobId: string
  jobtreadJobName: string | null  // C4: nullable — Supabase column is nullable
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
  const jobRef = candidate.jobtreadJobName ?? candidate.jobtreadJobId  // C4: fallback to ID
  return (
    `Hi ${candidate.vendorName}${trade} — this is a check-in from Thomas Pools regarding ` +
    `the ${jobRef} project. Can you share a quick status update? Reply to this message.`
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

  // C6: single query for all recent log entries instead of N+1 per-vendor queries
  const vendorIds = vendors.map(v => v.id)
  const { data: recentLogs, error: logErr } = await supabase
    .from('outreach_log')
    .select('vendor_id, sent_at, status')
    .in('vendor_id', vendorIds)
    .order('sent_at', { ascending: false })

  if (logErr) throw new Error(`Failed to fetch outreach logs: ${logErr.message}`)

  // Results are ordered desc — first hit per vendor_id is the most recent entry
  const lastLogByVendor = new Map<string, { sent_at: string; status: string }>()
  for (const log of recentLogs ?? []) {
    if (!lastLogByVendor.has(log.vendor_id)) {
      lastLogByVendor.set(log.vendor_id, { sent_at: log.sent_at, status: log.status })
    }
  }

  const cutoff = new Date(Date.now() - OUTREACH_INTERVAL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const candidates: OutreachCandidate[] = []

  for (const vendor of vendors) {
    const lastEntry = lastLogByVendor.get(vendor.id)

    if (lastEntry) {
      // C2: active conversation — vendor replied or was escalated, don't outreach again
      if (lastEntry.status === 'replied' || lastEntry.status === 'escalated') continue
      // C3: failed entries fall through so the next run retries the SMS
      // sent/followed_up entries within the interval are handled by Task 17's follow-up cron
      if (lastEntry.status !== 'failed' && lastEntry.sent_at > cutoff) continue
    }

    candidates.push({
      vendorId: vendor.id,
      vendorName: vendor.name,
      phone: vendor.phone,
      trade: vendor.trade ?? null,
      jobtreadJobId: vendor.jobtread_job_id,
      jobtreadJobName: vendor.jobtread_job_name ?? null,
    })
  }

  return candidates
}

// C5: in-process lock so a manual HTTP trigger can't race the scheduled cron
let isRunning = false

export async function runVendorOutreach(): Promise<OutreachResult[]> {
  if (isRunning) {
    console.warn('[vendor-outreach] Already running — skipping concurrent trigger')
    return []
  }
  isRunning = true

  const results: OutreachResult[] = []
  let candidateCount = 0
  let sentCount = 0

  try {
    const candidates = await fetchCandidates()
    candidateCount = candidates.length

    const testPhone = process.env.VENDOR_OUTREACH_TEST_PHONE

    for (const candidate of candidates) {
      const body = buildSmsBody(candidate)
      const toPhone = testPhone ?? candidate.phone
      try {
        const smsResult = await sendSms(toPhone, body)

        // C1: separate try/catch so a log insert failure doesn't mark a delivered SMS as 'failed'
        try {
          await supabase.from('outreach_log').insert({
            vendor_id: candidate.vendorId,
            jobtread_job_id: candidate.jobtreadJobId,
            message_sent: body,
            status: 'sent',
            twilio_message_sid: smsResult.sid,
          })
        } catch (insertErr) {
          console.error(
            `[vendor-outreach] Log insert failed for ${candidate.vendorName} (SMS was delivered):`,
            insertErr instanceof Error ? insertErr.message : insertErr,
          )
        }

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
  } finally {
    isRunning = false
  }

  return results
}

// Fires daily at 9 AM America/Los_Angeles — early enough to catch vendors before noon.
export function startVendorOutreach(): void {
  cron.schedule('0 9 * * *', () => {
    runVendorOutreach().catch(async err => {
      console.error('[vendor-outreach]', err instanceof Error ? err.message : err)
      await postErrorAlert('vendor-outreach', err)
    })
  }, { timezone: TZ })
}
