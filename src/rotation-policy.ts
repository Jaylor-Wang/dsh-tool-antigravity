/**
 * Account rotation policy for the multi-account pool.
 *
 * Kept deliberately small: this module decides *whether* a failure should move to the
 * next account and *how long* the failed account rests. The pool store owns the cursor
 * and the cooldown bookkeeping; the credential coordinator owns when a refresh failed.
 *
 * The distinction that matters is capacity vs. account. A 503/529 means Google is
 * overloaded, which is not this account's fault, so rotating would burn every account's
 * reputation for nothing. Only failures that are genuinely account-scoped rotate.
 */

import { calculateBackoffMs, parseRateLimitReason, type RateLimitReason } from '@cortexkit/antigravity-auth-core'

export type { RateLimitReason }

/**
 * How a refresh failure should be handled. `rotate` advances to the next account;
 * `stay` retries the same account after a backoff; `relogin` means the grant is dead and
 * no amount of rotation will help.
 */
export type RotationAction = 'rotate' | 'stay' | 'relogin'

export interface RotationDecision {
  readonly action: RotationAction
  /** Rest duration for the failed account; only meaningful for `rotate`. */
  readonly cooldownMs: number
  /** Wait before retrying; only meaningful for `stay`. */
  readonly retryAfterMs: number
  readonly reason: RateLimitReason
}

export interface RotationPolicyInput {
  /** Provider-supplied error code, if any (e.g. Google's `reason` field). */
  readonly reason?: string | undefined
  /** Human-readable provider message, used only to classify the failure. */
  readonly message?: string | undefined
  /** HTTP status of the failed refresh, if one was received. */
  readonly status?: number | undefined
  /** Consecutive failures already recorded for this account. */
  readonly consecutiveFailures: number
  /** A `Retry-After` header value in milliseconds, when the provider sent one. */
  readonly retryAfterMs?: number | null
  readonly random?: (() => number) | undefined
}

/**
 * Error codes meaning "this grant is dead". Both spellings appear in practice: Google's
 * OAuth body uses `invalid_grant`, while this plugin's own CredentialOperationError uses
 * the hyphenated `invalid-grant`.
 */
const DEAD_GRANT_CODES = new Set(['INVALID_GRANT', 'INVALID-GRANT', 'UNAUTHENTICATED', 'AUTHENTICATION', 'RELOGIN-REQUIRED'])

/**
 * Classify one refresh failure into a rotation decision.
 *
 * Callers pass whatever they know; `parseRateLimitReason` handles the provider-specific
 * vocabulary so this stays a thin policy layer over the shared core.
 */
/**
 * A dead grant can arrive three ways: as a structured `reason`, inside the message text,
 * or as a bare 401. All three mean "this account cannot be refreshed", and rotating to
 * another account would not help because the caller must sign in again.
 */
function isDeadGrant(input: RotationPolicyInput): boolean {
  const code = input.reason?.toUpperCase()
  if (code !== undefined && DEAD_GRANT_CODES.has(code)) return true
  const message = input.message?.toUpperCase()
  // Google reports an expired refresh token as `invalid_grant` in the message body even
  // when the structured reason is absent, so the text has to be inspected too.
  if (message !== undefined && [...DEAD_GRANT_CODES].some(dead => message.includes(dead))) return true
  return input.status === 401
}

export function decideRotation(input: RotationPolicyInput): RotationDecision {
  if (isDeadGrant(input)) {
    return { action: 'relogin', cooldownMs: 0, retryAfterMs: 0, reason: 'UNKNOWN' }
  }

  const reason = parseRateLimitReason(input.reason, input.message, input.status)
  const backoff = calculateBackoffMs(
    reason,
    input.consecutiveFailures,
    input.retryAfterMs ?? null,
    input.random,
  )

  switch (reason) {
    case 'QUOTA_EXHAUSTED':
    case 'RATE_LIMIT_EXCEEDED':
      // Genuinely account-scoped: this account is out of budget, so rest it and move on.
      return { action: 'rotate', cooldownMs: backoff, retryAfterMs: 0, reason }
    case 'MODEL_CAPACITY_EXHAUSTED':
    case 'SERVER_ERROR':
      // Google-side pressure. Rotating would spread the damage across healthy accounts.
      return { action: 'stay', cooldownMs: 0, retryAfterMs: backoff, reason }
    case 'UNKNOWN':
      // Rotate on an unclassified failure: with several accounts signed in, trying the
      // next one is strictly more informative than failing the request outright. A dead
      // grant never reaches here — `isDeadGrant` already returned.
      return { action: 'rotate', cooldownMs: backoff, retryAfterMs: 0, reason }
    default:
      return { action: 'rotate', cooldownMs: backoff, retryAfterMs: 0, reason }
  }
}

/**
 * Bounded retry budget for one user request, so a fully exhausted pool fails promptly
 * instead of cycling forever.
 */
export function rotationAttemptBudget(accountCount: number): number {
  return Math.max(1, accountCount)
}
