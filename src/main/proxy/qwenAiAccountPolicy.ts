/**
 * Classify a Qwen failure at the account boundary.
 *
 * The upstream sometimes sends an Error-like object without the adapter's
 * derived `accountFault` flag (for example after an Axios/socket wrapper).
 * Keep the fallback deliberately narrow: authentication failures and the
 * provider's explicit capacity class may move to another account; ordinary
 * throttling, transient gateway failures, and conversation state errors may
 * not.
 */
export type QwenAiAccountFailureClassification = {
  accountFault?: unknown
  status?: unknown
  statusCode?: unknown
  errorCode?: unknown
  code?: unknown
  param?: unknown
  message?: unknown
  error?: unknown
  response?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function numericStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const direct = [value.status, value.statusCode]
    .find(candidate => typeof candidate === 'number')
  if (typeof direct === 'number') return direct
  if (isRecord(value.response) && typeof value.response.status === 'number') {
    return value.response.status
  }
  return undefined
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value[field]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

function nestedValue(value: unknown, field: string): unknown {
  if (!isRecord(value)) return undefined
  return value[field]
}

function statusOf(value: QwenAiAccountFailureClassification): number | undefined {
  const direct = numericStatus(value)
  if (direct !== undefined) return direct
  const nestedError = nestedValue(value, 'error')
  return numericStatus(nestedError)
}

function codeOf(value: QwenAiAccountFailureClassification): string {
  const direct = stringField(value, 'errorCode') || stringField(value, 'code')
  if (direct) return direct.toUpperCase()
  const nestedError = nestedValue(value, 'error')
  return (stringField(nestedError, 'errorCode') || stringField(nestedError, 'code') || '').toUpperCase()
}

function paramOf(value: QwenAiAccountFailureClassification): string {
  const direct = stringField(value, 'param')
  if (direct) return direct.toLowerCase().replace(/[^a-z0-9]/g, '')
  const nestedError = nestedValue(value, 'error')
  const nested = stringField(nestedError, 'param')
  return nested ? nested.toLowerCase().replace(/[^a-z0-9]/g, '') : ''
}

/** Status/code combinations that must remain on the current conversation. */
export function isQwenAiAccountNeutralFailure(value: QwenAiAccountFailureClassification | undefined): boolean {
  if (!value) return false
  const status = statusOf(value)
  const code = codeOf(value)
  if (
    code === 'CHAT_IN_PROGRESS'
    || code === 'QWEN_AI_SESSION_STALE'
    || code === 'QWEN_AI_CONTINUATION_REJECTED'
    || status === 404
    || status === 409
  ) {
    return true
  }
  if (status === 400) {
    const param = paramOf(value)
    if (param === 'chatid' || param === 'conversationid' || param === 'parentid') return true
  }
  return false
}

/**
 * Return true only for an account fault. Explicit false always wins, while
 * an absent flag is inferred from the narrow status/code contract above.
 */
export function isQwenAiAccountFault(value: QwenAiAccountFailureClassification | undefined): boolean {
  if (!value || isQwenAiAccountNeutralFailure(value)) return false
  if (value.accountFault === false) return false

  const status = statusOf(value)
  const code = codeOf(value)
  // Account rotation is intentionally restricted to the documented classes.
  // An explicit true from a wrapper cannot turn a 5xx/ordinary 429 into an
  // account fault, which prevents the pool from being drained by congestion.
  return status === 401
    || status === 403
    || (status === 429 && code === 'QWEN_AI_CAPACITY_LIMIT')
}

/** The only inferred retry scope that is safe to use for account rotation. */
export function qwenAiAccountRetryScope(
  value: QwenAiAccountFailureClassification | undefined,
): 'next-account' | undefined {
  if (!value || value.accountFault === false || isQwenAiAccountNeutralFailure(value)) {
    return undefined
  }
  const status = statusOf(value)
  const code = codeOf(value)
  return status === 401
    || status === 403
    || (status === 429 && code === 'QWEN_AI_CAPACITY_LIMIT')
    ? 'next-account'
    : undefined
}
