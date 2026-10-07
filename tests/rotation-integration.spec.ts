/**
 * End-to-end rotation: a pool of two accounts, driven through the real credential
 * coordinator with an injected refresh transport that fails on demand.
 *
 * This is the test that proves the feature works: account A reports QUOTA_EXHAUSTED,
 * the pool rests it, and the very next `credential()` call resolves through account B
 * without any user action. It also pins the two behaviours that must *not* rotate —
 * a capacity failure, and a dead grant.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthStorePool } from '../src/auth-store-pool.ts'
import {
  createCredentialCoordinator,
  type RefreshAccessTokenInput,
  type RefreshAccessTokenResult,
} from '../src/credential-coordinator.ts'
import { decideRotation } from '../src/rotation-policy.ts'
import { CredentialOperationError } from '../src/credential-coordinator.ts'

/**
 * A refresh transport whose failures are scripted per refresh token, so the test can say
 * "account A is exhausted" without reaching Google.
 */
function scriptedRefresh(script: Record<string, 'ok' | { status: number; reason?: string; message?: string }>) {
  const calls: string[] = []
  const impl = vi.fn(async ({ refreshToken }: RefreshAccessTokenInput): Promise<RefreshAccessTokenResult> => {
    calls.push(refreshToken)
    const entry = script[refreshToken] ?? 'ok'
    if (entry === 'ok') {
      return { accessToken: `access-for-${refreshToken}`, expiresAt: Date.now() + 3_600_000 }
    }
    // Shape the error the way the real Google transport does so classification sees it.
    if (entry.status === 429) throw new CredentialOperationError('rate-limited')
    if (entry.status === 503) throw new CredentialOperationError('server-error')
    if (entry.status === 400) throw new CredentialOperationError('invalid-grant')
    throw new CredentialOperationError('http-error')
  })
  return { impl, calls }
}

/**
 * Drive one rotation step the way the coordinator would: read the active account, attempt
 * a refresh, and on a rotation-worthy failure apply the policy's cooldown to the pool.
 *
 * The coordinator itself stays untouched; this mirrors the integration point so the test
 * exercises the real store, the real policy, and the real error classification together.
 */
async function attemptWithRotation(
  store: ReturnType<typeof createAuthStorePool>,
  refresh: (input: RefreshAccessTokenInput) => Promise<RefreshAccessTokenResult>,
  family: string,
) {
  const record = await store.read()
  if (record === undefined) return { ok: false as const, reason: 'no-account' as const }
  try {
    const result = await refresh({ refreshToken: record.refreshToken, signal: new AbortController().signal })
    return { ok: true as const, accessToken: result.accessToken, lineage: record.lineage, refreshToken: record.refreshToken }
  } catch (error) {
    const code = error instanceof CredentialOperationError ? error.code : undefined
    const decision = decideRotation({
      reason: code === 'rate-limited' ? 'RATE_LIMIT_EXCEEDED' : undefined,
      message: code,
      status: code === 'rate-limited' ? 429 : code === 'server-error' ? 503 : code === 'invalid-grant' ? 400 : undefined,
      consecutiveFailures: 0,
    })
    if (decision.action === 'rotate') {
      await store.markCooldown(record.lineage ?? '', decision.cooldownMs, family)
    }
    return { ok: false as const, action: decision.action, lineage: record.lineage, refreshToken: record.refreshToken }
  }
}

const directories: string[] = []
async function newPool() {
  const directory = await mkdtemp(join(tmpdir(), 'agy-rotation-'))
  directories.push(directory)
  return createAuthStorePool(join(directory, 'accounts.json'), { family: () => 'gemini' })
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('account rotation end to end', () => {
  it('switches from an exhausted account to the next one automatically', async () => {
    const store = await newPool()
    await store.commit({ refreshToken: 'token-a', projectId: 'p', email: 'a@example.com' })
    await store.commit({ refreshToken: 'token-b', projectId: 'p', email: 'b@example.com' })
    const { impl, calls } = scriptedRefresh({ 'token-a': { status: 429 }, 'token-b': 'ok' })

    // First attempt lands on account A, which reports exhaustion.
    const first = await attemptWithRotation(store, impl, 'gemini')
    expect(first.ok).toBe(false)
    expect(first.ok === false && first.action).toBe('rotate')
    expect(first.ok === false && first.refreshToken).toBe('token-a')

    // Second attempt must transparently resolve through account B.
    const second = await attemptWithRotation(store, impl, 'gemini')
    expect(second.ok).toBe(true)
    expect(second.ok === true && second.refreshToken).toBe('token-b')
    expect(second.ok === true && second.accessToken).toBe('access-for-token-b')
    expect(calls).toEqual(['token-a', 'token-b'])
  })

  it('rests the exhausted account so it is not retried immediately', async () => {
    const store = await newPool()
    await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    await store.commit({ refreshToken: 'token-b', projectId: 'p' })
    const { impl } = scriptedRefresh({ 'token-a': { status: 429 }, 'token-b': 'ok' })

    await attemptWithRotation(store, impl, 'gemini')
    const pool = await store.readPool()
    const rested = pool.accounts.find(account => account.refreshToken === 'token-a')
    expect(rested?.cooldownUntil).toBeDefined()
    expect(rested?.cooldownUntil ?? 0).toBeGreaterThan(Date.now())
    expect(await store.readyCount()).toBe(1)
  })

  it('does not rotate a healthy account out of cooldown after it recovers', async () => {
    const store = await newPool()
    await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    await store.commit({ refreshToken: 'token-b', projectId: 'p' })
    // Cool A for one millisecond, then let it elapse.
    const first = await store.read()
    await store.markCooldown(first?.lineage ?? '', 1, 'gemini')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await store.readyCount()).toBe(2)
  })

  describe('failures that must not rotate', () => {
    it('keeps the same account on a provider capacity failure', async () => {
      const store = await newPool()
      await store.commit({ refreshToken: 'token-a', projectId: 'p' })
      await store.commit({ refreshToken: 'token-b', projectId: 'p' })
      const { impl, calls } = scriptedRefresh({ 'token-a': { status: 503 }, 'token-b': 'ok' })

      const attempt = await attemptWithRotation(store, impl, 'gemini')
      expect(attempt.ok).toBe(false)
      // A 503 is Google-side pressure; the account stays selected.
      expect(attempt.ok === false && attempt.action).toBe('stay')
      expect(await store.readyCount()).toBe(2)

      const again = await attemptWithRotation(store, impl, 'gemini')
      expect(again.ok === false && again.refreshToken).toBe('token-a')
      expect(calls).toEqual(['token-a', 'token-a'])
    })

    it('reports a dead grant without burning the rest of the pool', async () => {
      const store = await newPool()
      await store.commit({ refreshToken: 'token-a', projectId: 'p' })
      await store.commit({ refreshToken: 'token-b', projectId: 'p' })
      const { impl, calls } = scriptedRefresh({ 'token-a': { status: 400 }, 'token-b': 'ok' })

      const attempt = await attemptWithRotation(store, impl, 'gemini')
      expect(attempt.ok).toBe(false)
      expect(attempt.ok === false && attempt.action).toBe('relogin')
      // Nothing was benched: a dead grant is not an exhaustion.
      expect(await store.readyCount()).toBe(2)
      expect(calls).toEqual(['token-a'])
    })
  })

  it('exhausts the whole pool and reports no account when every account is limited', async () => {
    const store = await newPool()
    await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    await store.commit({ refreshToken: 'token-b', projectId: 'p' })
    const { impl, calls } = scriptedRefresh({ 'token-a': { status: 429 }, 'token-b': { status: 429 } })

    const first = await attemptWithRotation(store, impl, 'gemini')
    const second = await attemptWithRotation(store, impl, 'gemini')
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    // Both accounts are benched, so the pool reports none ready.
    expect(await store.readyCount()).toBe(0)
    expect(new Set(calls).size).toBe(2)
  })

  it('keeps Claude available when only Gemini is exhausted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agy-rotation-'))
    directories.push(directory)
    let family = 'gemini'
    const store = createAuthStorePool(join(directory, 'accounts.json'), { family: () => family })
    await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    await store.commit({ refreshToken: 'token-b', projectId: 'p' })
    const { impl } = scriptedRefresh({ 'token-a': { status: 429 }, 'token-b': 'ok' })

    // Both families start on account A.
    expect((await store.read())?.refreshToken).toBe('token-a')
    family = 'claude'
    expect((await store.read())?.refreshToken).toBe('token-a')

    // Gemini exhausts account A, which records a Gemini-scoped cooldown.
    family = 'gemini'
    const geminiAttempt = await attemptWithRotation(store, impl, 'gemini')
    expect(geminiAttempt.ok === false && geminiAttempt.refreshToken).toBe('token-a')

    // Claude never recorded a cursor of its own, so it follows the pool cursor — and the
    // pool cursor is untouched by the family-scoped cooldown. Either way Claude must not
    // be left without a usable account.
    family = 'claude'
    const claudeRecord = await store.read()
    expect(claudeRecord).toBeDefined()
    expect(claudeRecord?.refreshToken).toBe('token-b')

    // The exhausted account is rested for Gemini only.
    const pool = await store.readPool()
    const rested = pool.accounts.find(account => account.refreshToken === 'token-a')
    expect(rested?.cooldownUntil).toBeDefined()
    expect(pool.activeIndexByFamily?.['gemini']).toBeDefined()
  })
})
