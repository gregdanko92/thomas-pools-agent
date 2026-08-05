import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { validateWebhookSignature, parseInboundSms } from '../integrations/twilio'
import { postMessage } from '../integrations/slack'
import { complete } from '../integrations/claude'
import { supabase } from '../db/client'

// --- Types ---

export interface VendorRow {
  id: string
  name: string
  phone: string
  trade: string | null
  jobtread_job_id: string | null
  jobtread_job_name: string | null
}

export interface OutreachLogRow {
  id: string
  vendor_id: string
  jobtread_job_id: string
  message_sent: string
  sent_at: string
  status: string
  twilio_message_sid: string | null
  escalated_at: string | null
}

export interface InboundHandlerResult {
  logged: boolean
  flagged: boolean
  logId: string | null
}

// --- Triage ---

const TRIAGE_SYSTEM = `You are a vendor reply triage assistant for Thomas Pools, a pool construction company.
A project manager sent an outreach SMS to a vendor asking for a status update or scheduling confirmation.
You will see the original outreach message and the vendor's reply.
Decide if the reply needs immediate PM attention.

Reply with exactly one word: "yes" or "no".

Flag as "yes" if the reply indicates: a delay, a problem, a schedule conflict, unavailability, an unusual request, or anything that would require the PM to take action.
Reply "no" if the vendor confirms on schedule, says they are on track, or provides a routine update with no blockers.`

async function triageReply(outreachMessage: string, vendorReply: string): Promise<boolean> {
  const prompt = `Original outreach message:\n"${outreachMessage}"\n\nVendor reply:\n"${vendorReply}"\n\nDoes this reply need immediate PM attention?`
  const answer = await complete(prompt, { system: TRIAGE_SYSTEM, maxTokens: 10 })
  return answer.trim().toLowerCase().startsWith('yes')
}

// --- Core handler ---

export async function handleInboundSms(
  params: Record<string, string>,
  rawUrl: string,
  twilioSignature: string,
): Promise<InboundHandlerResult> {
  if (!validateWebhookSignature(rawUrl, params, twilioSignature)) {
    throw new Error('Invalid Twilio webhook signature')
  }

  const { from, body } = parseInboundSms(params)
  if (!body.trim()) {
    return { logged: false, flagged: false, logId: null }
  }

  // Normalize phone to E.164 — Twilio sends +1XXXXXXXXXX, our vendors table stores the same format.
  const normalizedFrom = from.startsWith('+') ? from : `+${from}`

  const { data: vendors, error: vendorErr } = await supabase
    .from('vendors')
    .select('id, name, phone, trade, jobtread_job_id, jobtread_job_name')
    .eq('phone', normalizedFrom)
    .eq('active', true)
    .limit(1)

  if (vendorErr) throw new Error(`Vendor lookup failed: ${vendorErr.message}`)

  const vendor = vendors?.[0] as VendorRow | undefined
  if (!vendor) {
    // Unknown number — log and ignore. No PM alert needed since we can't attribute the reply.
    await supabase.from('agent_run_log').insert({
      run_type: 'twilio_inbound',
      details: { from: normalizedFrom, bodyLength: body.length, reason: 'unknown_number' },
      success: true,
    })
    return { logged: false, flagged: false, logId: null }
  }

  // Find the most recent open outreach for this vendor.
  const { data: logs, error: logErr } = await supabase
    .from('outreach_log')
    .select('id, vendor_id, jobtread_job_id, message_sent, sent_at, status, twilio_message_sid')
    .eq('vendor_id', vendor.id)
    .in('status', ['sent', 'followed_up', 'no_reply'])
    .order('sent_at', { ascending: false })
    .limit(1)

  if (logErr) throw new Error(`Outreach log lookup failed: ${logErr.message}`)

  const openLog = logs?.[0] as OutreachLogRow | undefined

  const flagged = await triageReply(openLog?.message_sent ?? '', body)

  if (openLog) {
    const { error: updateErr } = await supabase
      .from('outreach_log')
      .update({
        reply_text: body,
        replied_at: new Date().toISOString(),
        status: flagged ? 'escalated' : 'replied',
        ...(flagged ? { escalated_at: new Date().toISOString() } : {}),
      })
      .eq('id', openLog.id)

    if (updateErr) throw new Error(`Outreach log update failed: ${updateErr.message}`)
  }

  await supabase.from('agent_run_log').insert({
    run_type: 'twilio_inbound',
    jobtread_job_id: openLog?.jobtread_job_id ?? vendor.jobtread_job_id ?? null,
    details: {
      vendorId: vendor.id,
      vendorName: vendor.name,
      outreachLogId: openLog?.id ?? null,
      flagged,
    },
    success: true,
  })

  if (flagged) {
    const pmChannel = process.env.SLACK_PM_ALERTS_CHANNEL
    if (pmChannel) {
      const jobLabel = openLog?.jobtread_job_id
        ? (vendor.jobtread_job_name ? ` (${vendor.jobtread_job_name})` : ` job ${openLog.jobtread_job_id}`)
        : ''
      await postMessage(
        pmChannel,
        `*Vendor reply needs attention*\n` +
          `Vendor: *${vendor.name}*${vendor.trade ? ` — ${vendor.trade}` : ''}${jobLabel}\n` +
          `Reply: "${body}"`,
      )
    }
  }

  return { logged: true, flagged, logId: openLog?.id ?? null }
}

// --- Fastify route registration ---

export function registerTwilioInboundWebhook(server: FastifyInstance): void {
  // Twilio sends POST with application/x-www-form-urlencoded body.
  // hasContentTypeParser guards against FST_ERR_CTP_ALREADY_PRESENT if this
  // function is called more than once on the same Fastify instance (e.g. in tests).
  if (!server.hasContentTypeParser('application/x-www-form-urlencoded')) {
    server.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const parsed = Object.fromEntries(new URLSearchParams(body as string))
          done(null, parsed)
        } catch (err) {
          done(err as Error, undefined)
        }
      },
    )
  }

  server.post('/webhooks/twilio/inbound', async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.body as Record<string, string>
    const signature = (req.headers['x-twilio-signature'] as string) ?? ''

    // Reconstruct the public URL Twilio signed — Railway exposes PORT but the
    // public host comes from RAILWAY_PUBLIC_DOMAIN or TWILIO_WEBHOOK_BASE_URL.
    const domain = process.env.TWILIO_WEBHOOK_BASE_URL ?? (
      process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : null
    )
    if (!domain) {
      server.log.error('TWILIO_WEBHOOK_BASE_URL and RAILWAY_PUBLIC_DOMAIN are both unset — cannot validate Twilio signature')
      return reply.status(200).type('text/xml').send('<Response/>')
    }
    const rawUrl = `${domain}/webhooks/twilio/inbound`

    try {
      await handleInboundSms(params, rawUrl, signature)
    } catch (err) {
      server.log.error({ err }, 'twilio inbound webhook error')
      // Always return 200 to Twilio — non-2xx causes Twilio to retry.
      return reply.status(200).send('<Response/>')
    }

    return reply.status(200).type('text/xml').send('<Response/>')
  })
}
