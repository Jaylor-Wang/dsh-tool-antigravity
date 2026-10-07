/**
 * Rotation policy: which failures move accounts, which wait, and which need a re-login.
 *
 * The load-bearing distinction is account-scoped exhaustion versus provider-side
 * capacity pressure; rotating on the latter would rotate healthy accounts for nothing.
 */

import { describe, expect, it } from 'vitest'
import { decideRotation, rotationAttemptBudget } from '../src/rotation-policy.ts'

function decide(overrides: Partial<Parameters<typeof decideRotation>[0]> = {}) {
  return decideRotation({ consecutiveFailures: 0, ...overrides })
}

describe('rotation-policy', () => {
  describe('account-scoped exhaustion rotates', () => {
    it('rotates on an explicit QUOTA_EXHAUSTED reason', () => {
      expect(decide({ reason: 'QUOTA_EXHAUSTED' }).action).toBe('rotate')
    })

    it('rotates on a 429 with no explicit reason', () => {
      expect(decide({ status: 429 }).action).toBe('rotate')
    })

    it('rotates when the message says quota is exhausted', () => {
      expect(decide({ message: 'You have exhausted your quota for this model' }).action).toBe('rotate')
    })

    it('rotates when the message reports a per-minute limit', () => {
      const decision = decide({ message: 'Rate limit exceeded, too many requests per minute' })
      expect(decision.action).toBe('rotate')
      expect(decision.reason).toBe('RATE_LIMIT_EXCEEDED')
    })

    it('produces a positive cooldown so the account actually rests', () => {
      const decision = decide({ reason: 'QUOTA_EXHAUSTED' })
      expect(decision.cooldownMs).toBeGreaterThan(0)
      expect(decision.retryAfterMs).toBe(0)
    })

    it('escalates the cooldown as consecutive failures accumulate', () => {
      const first = decide({ reason: 'QUOTA_EXHAUSTED', consecutiveFailures: 0 })
      const later = decide({ reason: 'QUOTA_EXHAUSTED', consecutiveFailures: 3 })
      expect(later.cooldownMs).toBeGreaterThan(first.cooldownMs)
    })

    it('honours a provider Retry-After value over the ladder', () => {
      const decision = decide({ reason: 'QUOTA_EXHAUSTED', retryAfterMs: 5_000 })
      expect(decision.cooldownMs).toBe(5_000)
    })
  })

  describe('provider-side capacity pressure does NOT rotate', () => {
    it('stays on a 503', () => {
      const decision = decide({ status: 503 })
      expect(decision.action).toBe('stay')
      expect(decision.reason).toBe('MODEL_CAPACITY_EXHAUSTED')
      expect(decision.cooldownMs).toBe(0)
      expect(decision.retryAfterMs).toBeGreaterThan(0)
    })

    it('stays on a 529', () => {
      expect(decide({ status: 529 }).action).toBe('stay')
    })

    it('stays on a 500', () => {
      const decision = decide({ status: 500 })
      expect(decision.action).toBe('stay')
      expect(decision.reason).toBe('SERVER_ERROR')
    })

    it('stays when the message reports the model is overloaded', () => {
      expect(decide({ message: 'The model is currently overloaded' }).action).toBe('stay')
    })

    it('never assigns a cooldown to a capacity failure', () => {
      // A cooldown here would bench a perfectly healthy account.
      for (const status of [503, 529, 500]) {
        expect(decide({ status }).cooldownMs).toBe(0)
      }
    })
  })

  describe('dead grants require re-login instead of rotation', () => {
    it('reports relogin for invalid_grant', () => {
      const decision = decide({ message: 'invalid_grant', status: 400 })
      expect(decision.action).toBe('relogin')
    })

    it('reports relogin for a 401', () => {
      expect(decide({ status: 401 }).action).toBe('relogin')
    })

    it('reports relogin for the explicit INVALID_GRANT code', () => {
      expect(decide({ reason: 'INVALID_GRANT' }).action).toBe('relogin')
    })

    it('never rotates or cools on a dead grant', () => {
      const decision = decide({ status: 401 })
      expect(decision.cooldownMs).toBe(0)
      expect(decision.retryAfterMs).toBe(0)
    })
  })

  describe('unclassified failures', () => {
    it('rotates rather than failing outright, so another account gets a chance', () => {
      expect(decide({ message: 'something unexpected' }).action).toBe('rotate')
    })

    it('still assigns a bounded cooldown', () => {
      const decision = decide({ message: 'something unexpected' })
      expect(decision.cooldownMs).toBeGreaterThan(0)
      expect(Number.isFinite(decision.cooldownMs)).toBe(true)
    })
  })

  describe('determinism', () => {
    it('is stable for the same input when the jitter source is injected', () => {
      const make = () => decide({ status: 503, consecutiveFailures: 1, random: () => 0.5 })
      expect(make()).toEqual(make())
    })
  })

  describe('attempt budget', () => {
    it('allows one attempt per account', () => {
      expect(rotationAttemptBudget(3)).toBe(3)
    })

    it('never returns less than one attempt', () => {
      expect(rotationAttemptBudget(0)).toBe(1)
    })
  })
})
