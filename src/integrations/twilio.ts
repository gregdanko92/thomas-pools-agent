import twilio from 'twilio'

// --- Types ---

export interface SendSmsResult {
  sid: string
  status: string
  to: string
  from: string
}

export interface InboundSmsPayload {
  messageSid: string
  from: string
  to: string
  body: string
  numMedia: number
}

// --- Env ---

function accountSid(): string {
  const sid = process.env.TWILIO_ACCOUNT_SID
  if (!sid) throw new Error('TWILIO_ACCOUNT_SID is not set')
  return sid
}

function apiKeySid(): string {
  const sid = process.env.TWILIO_API_KEY_SID
  if (!sid) throw new Error('TWILIO_API_KEY_SID is not set')
  return sid
}

function apiKeySecret(): string {
  const secret = process.env.TWILIO_API_KEY_SECRET
  if (!secret) throw new Error('TWILIO_API_KEY_SECRET is not set')
  return secret
}

// Auth token is still required by Twilio for webhook signature validation — API keys cannot replace it there.
function authToken(): string {
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!token) throw new Error('TWILIO_AUTH_TOKEN is not set')
  return token
}

function fromNumber(): string {
  const number = process.env.TWILIO_FROM_NUMBER
  if (!number) throw new Error('TWILIO_FROM_NUMBER is not set')
  return number
}

// --- Client ---

let _client: twilio.Twilio | null = null

function getClient(): twilio.Twilio {
  if (!_client) {
    _client = twilio(apiKeySid(), apiKeySecret(), { accountSid: accountSid() })
  }
  return _client
}

// --- Outbound SMS ---

export async function sendSms(to: string, body: string): Promise<SendSmsResult> {
  const message = await getClient().messages.create({ body, from: fromNumber(), to })
  return {
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from,
  }
}

// --- Inbound webhook helpers ---

export function validateWebhookSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  return twilio.validateRequest(authToken(), signature, url, params)
}

export function parseInboundSms(params: Record<string, string>): InboundSmsPayload {
  return {
    messageSid: params['MessageSid'] ?? '',
    from: params['From'] ?? '',
    to: params['To'] ?? '',
    body: params['Body'] ?? '',
    numMedia: parseInt(params['NumMedia'] ?? '0', 10) || 0,
  }
}
