/**
 * Account management: the status view publishes the pool, and the two operations move the
 * cursor or remove an account without leaking identity material.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accountHandle, createAntigravityAuthService } from '../src/auth-service.ts'
import { createAuthStorePool, readPoolFile } from '../src/auth-store-pool.ts'
import { createMemoryCapabilityGates } from '../src/capability-gates.ts'

const directories: string[] = []

async function workspace(): Promise<{ directory: string; storePath: string; poolPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'agy-accounts-'))
  directories.push(directory)
  return { directory, storePath: join(directory, 'auth.json'), poolPath: join(directory, 'accounts.json') }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function pooledService(storePath: string) {
  return createAntigravityAuthService({
    storePath,
    multiAccount: true,
    gates: createMemoryCapabilityGates(),
  })
}

describe('status publishes the account pool', () => {
  it('marks the install as pooled and lists every account', async () => {
    const { storePath, poolPath } = await workspace()
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-a', projectId: 'p', email: 'alpha@example.com' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p', email: 'bravo@example.com' })

    const status = await pooledService(storePath).status()
    expect(status.singleAccount).toBe(false)
    expect(status.accounts).toHaveLength(2)
    // Exactly one account is the one a request would resolve to.
    expect(status.accounts.filter(account => account.active)).toHaveLength(1)
  })

  it('keeps the single-record install reported as single-account', async () => {
    const { storePath } = await workspace()
    const service = createAntigravityAuthService({
      storePath,
      multiAccount: false,
      gates: createMemoryCapabilityGates(),
    })
    const status = await service.status()
    expect(status.singleAccount).toBe(true)
    expect(status.accounts).toEqual([])
  })

  it('never publishes a raw address or a lineage', async () => {
    const { storePath, poolPath } = await workspace()
    const pool = createAuthStorePool(poolPath)
    const committed = await pool.commit({ refreshToken: 'token-a', projectId: 'p', email: 'alice@example.com' })

    const status = await pooledService(storePath).status()
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).not.toContain(committed.lineage ?? 'unreachable')
    expect(status.accounts[0]?.email).toBe('a***@example.com')
    // The handle is a stable hash, not the lineage itself.
    expect(status.accounts[0]?.id).toBe(accountHandle(committed.lineage ?? ''))
  })

  it('reports a resting account with its remaining cooldown', async () => {
    const { storePath, poolPath } = await workspace()
    const pool = createAuthStorePool(poolPath)
    const committed = await pool.commit({ refreshToken: 'token-a', projectId: 'p' })
    await pool.markCooldown(committed.lineage ?? '', 120_000)

    const status = await pooledService(storePath).status()
    expect(status.accounts[0]?.coolingUntil).toBeGreaterThan(Date.now())
    expect(status.accounts[0]?.failureCount).toBe(1)
  })
})

describe('account operations', () => {
  it('selects an account by handle and moves the active marker', async () => {
    const { storePath, poolPath } = await workspace()
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-a', projectId: 'p', email: 'alpha@example.com' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p', email: 'bravo@example.com' })
    const service = pooledService(storePath)

    const before = await service.status()
    const target = before.accounts.find(account => !account.active)
    expect(target).toBeDefined()

    expect(await service.selectAccount(target?.id ?? '')).toEqual({ state: 'selected' })
    const after = await service.status()
    expect(after.accounts.find(account => account.id === target?.id)?.active).toBe(true)
  })

  it('does not clear a cooldown when an account is merely selected', async () => {
    const { storePath, poolPath } = await workspace()
    const pool = createAuthStorePool(poolPath)
    const first = await pool.commit({ refreshToken: 'token-a', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p' })
    await pool.markCooldown(first.lineage ?? '', 300_000)

    const service = pooledService(storePath)
    const status = await service.status()
    const resting = status.accounts.find(account => account.coolingUntil !== undefined)
    await service.selectAccount(resting?.id ?? '')
    // Selecting is a preference, not proof: the account must stay rested.
    const after = await service.status()
    expect(after.accounts.find(account => account.id === resting?.id)?.coolingUntil).toBeDefined()
  })

  it('removes an account and leaves the rest of the pool intact', async () => {
    const { storePath, poolPath } = await workspace()
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-a', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p' })
    const service = pooledService(storePath)

    const status = await service.status()
    const victim = status.accounts[1]
    expect(await service.removeAccount(victim?.id ?? '')).toEqual({ state: 'removed' })

    const after = await service.status()
    expect(after.accounts).toHaveLength(1)
    expect(after.accounts.some(account => account.id === victim?.id)).toBe(false)
    expect((await readPoolFile(poolPath)).accounts).toHaveLength(1)
  })

  it('reports an unknown handle instead of guessing', async () => {
    const { storePath, poolPath } = await workspace()
    await createAuthStorePool(poolPath).commit({ refreshToken: 'token-a', projectId: 'p' })
    const service = pooledService(storePath)

    expect(await service.selectAccount('no-such-handle')).toEqual({ state: 'unknown-account' })
    expect(await service.removeAccount('no-such-handle')).toEqual({ state: 'unknown-account' })
  })

  it('rejects a malformed handle without touching the pool', async () => {
    const { storePath, poolPath } = await workspace()
    await createAuthStorePool(poolPath).commit({ refreshToken: 'token-a', projectId: 'p' })
    const service = pooledService(storePath)

    for (const handle of ['', 'x'.repeat(200)]) {
      expect(await service.selectAccount(handle)).toEqual({ state: 'unknown-account' })
    }
    expect((await readPoolFile(poolPath)).accounts).toHaveLength(1)
  })

  it('refuses account management on the single-record install', async () => {
    const { storePath } = await workspace()
    const service = createAntigravityAuthService({
      storePath,
      multiAccount: false,
      gates: createMemoryCapabilityGates(),
    })
    // No pool means no account list to act on; the caller is told rather than ignored.
    await expect(service.selectAccount(randomUUID())).rejects.toThrow(/does not use an account pool/u)
    await expect(service.removeAccount(randomUUID())).rejects.toThrow(/does not use an account pool/u)
  })

  it('removing the active account leaves the pool usable', async () => {
    const { storePath, poolPath } = await workspace()
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-a', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p' })
    const service = pooledService(storePath)

    const active = (await service.status()).accounts.find(account => account.active)
    await service.removeAccount(active?.id ?? '')

    const after = await service.status()
    expect(after.accounts).toHaveLength(1)
    // The survivor becomes active, so a subsequent request still resolves somewhere.
    expect(after.accounts[0]?.active).toBe(true)
  })

  it('empties the pool when the last account is removed', async () => {
    const { storePath, poolPath } = await workspace()
    await createAuthStorePool(poolPath).commit({ refreshToken: 'token-a', projectId: 'p' })
    const service = pooledService(storePath)

    const only = (await service.status()).accounts[0]
    await service.removeAccount(only?.id ?? '')

    const after = await service.status()
    expect(after.accounts).toHaveLength(0)
    // An empty pool is still a pool: the UI must not silently fall back to single-account.
    expect(after.singleAccount).toBe(false)
  })
})
