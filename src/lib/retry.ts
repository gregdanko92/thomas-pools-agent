export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  shouldRetry?: (err: unknown) => boolean
}

// Returns true for transient failures that are safe to retry:
// network-level errors, 429 rate-limit, and 5xx server errors.
// 4xx client errors (bad request, auth failure) are not retried.
function isRetryable(err: unknown): boolean {
  // Node.js fetch() throws TypeError on network failure with messages like "fetch failed".
  // Narrow this to known network-error patterns so programmer TypeErrors (null deref,
  // undefined property) are not silently retried 3 times before surfacing.
  if (err instanceof TypeError && /fetch|network|socket|connect/i.test(err.message)) return true

  if (err instanceof Error) {
    // Pattern used by jobtread.ts: "... failed: 503 Service Unavailable"
    const m = err.message.match(/\b([45]\d{2})\b/)
    if (m) {
      const s = Number(m[1])
      return s === 429 || s >= 500
    }
  }

  // Twilio SDK: error.status (number), googleapis GaxiosError: error.response.status
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>
    const direct = typeof e.status === 'number' ? e.status : undefined
    const nested = (e.response as Record<string, unknown> | undefined)?.status
    const status = direct ?? (typeof nested === 'number' ? nested : undefined)
    if (typeof status === 'number') return status === 429 || status >= 500
  }

  return false
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 1000
  const retryable = options.shouldRetry ?? isRetryable

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === maxAttempts || !retryable(err)) throw err
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 200
      console.warn(
        `[retry] attempt ${attempt}/${maxAttempts} failed — retrying in ${Math.round(delay)}ms:`,
        err instanceof Error ? err.message : err,
      )
      await new Promise(r => setTimeout(r, delay))
    }
  }

  // unreachable: loop exits only via return (success) or throw (final attempt or non-retryable)
  throw new Error('[retry] internal error: loop exited without return or throw')
}
