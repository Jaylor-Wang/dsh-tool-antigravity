/**
 * Multi-account pool store: append-on-new-lineage, family-aware cursor rotation,
 * cooldown bookkeeping, legacy migration, and on-disk robustness.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTH_POOL_VERSION,
  createAuthStorePool,
  defaultAuthPoolPath,
  migrateLegacyRecord,
  readPoolFile,
  writePoolFile,
  type AuthPoolFile,
} from '../src/auth-store-pool.ts'
import { AuthStoreError, createAuthStore, type AntigravityAuthRecord } from '../src/auth-store.ts'

const temporaryDirectories: string[] = []

async function poolPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agy-pool-'))
  temporaryDirectories.push(directory)
  return join(directory, 'accounts.json')
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function record(overrides: Partial<AntigravityAuthRecord> = {}): AntigravityAuthRecord {
  return {
    version: 1,
    refreshToken: 'refresh-token-placeholder',
    projectId: 'aicode-consumers',
    revision: 1,
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    lineage: 'lineage-a',
    ...overrides,
  }
}

describe('auth-store-pool', () => {
  it('reads undefined when no pool file exists', async () => {
    const store = createAuthStorePool(await poolPath())
    expect(await store.read()).toBeUndefined()
    expect((await store.readPool()).accounts).toHaveLength(0)
  })

  it('appends a second account instead of replacing the first on a new lineage', async () => {
    const store = createAuthStorePool(await poolPath())
    // A fresh login: no observed lineage, so the pool records a brand-new account.
    await store.compareAndCommit(0, { refreshToken: 'token-a', projectId: 'project-a' }, undefined)
    const pool = await store.readPool()
    expect(pool.accounts).toHaveLength(1)
    const firstLineage = pool.accounts[0]?.lineage ?? ''
    expect(firstLineage).not.toBe('')

    // The second login is a *different* account, so it carries its own lineage. Appending
    // instead of replacing here is the behaviour that turns one slot into a pool. A caller
    // that means "refresh the active account" omits the lineage instead (next test),
    // which keeps the original single-record semantics intact.
    await store.compareAndCommit(pool.revision, { refreshToken: 'token-b', projectId: 'project-b', lineage: 'lineage-b' }, undefined)
    const grown = await store.readPool()
    expect(grown.accounts).toHaveLength(2)
    expect(grown.accounts.map(account => account.refreshToken)).toEqual(['token-a', 'token-b'])
    // The original account survived untouched.
    expect(grown.accounts[0]?.lineage).toBe(firstLineage)
  })

  it('replaces the active account when a caller omits any lineage', async () => {
    // Single-record compatibility: an unqualified compareAndCommit refreshes the active
    // account rather than silently growing the pool.
    const store = createAuthStorePool(await poolPath())
    await store.compareAndCommit(0, { refreshToken: 'token-a', projectId: 'project-a' }, undefined)
    const after = await store.read()
    await store.compareAndCommit(after?.revision ?? 0, { refreshToken: 'token-a-2', projectId: 'project-a' }, undefined)
    const pool = await store.readPool()
    expect(pool.accounts).toHaveLength(1)
    expect(pool.accounts[0]?.refreshToken).toBe('token-a-2')
  })

  it('updates an existing account in place when the lineage matches', async () => {
    const store = createAuthStorePool(await poolPath())
    const created = await store.compareAndCommit(0, { refreshToken: 'token-a', projectId: 'project-a' }, undefined)
    expect(created).toBeDefined()
    const lineage = created?.lineage ?? ''

    await store.compareAndCommit(created?.revision ?? 0, { refreshToken: 'token-a-rotated', projectId: 'project-a' }, lineage)
    const pool = await store.readPool()
    expect(pool.accounts).toHaveLength(1)
    expect(pool.accounts[0]?.refreshToken).toBe('token-a-rotated')
    expect(pool.accounts[0]?.lineage).toBe(lineage)
  })

  it('appends when the draft names a lineage the pool has never seen', async () => {
    // This is the shape `commitLogin` uses for a brand-new account: a fresh lineage in the
    // draft, and no *observed* lineage, because the account does not exist yet. Naming it as
    // the observed lineage would instead demand an account that is not there.
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    const before = await store.readPool()

    const appended = await store.compareAndCommit(
      before.revision,
      { refreshToken: 'token-b', projectId: 'project-b', lineage: 'brand-new-lineage' },
      undefined,
    )
    expect(appended).toBeDefined()
    expect(appended?.lineage).toBe('brand-new-lineage')
    const after = await store.readPool()
    expect(after.accounts).toHaveLength(2)
    expect(after.accounts.map(account => account.refreshToken)).toEqual(['token-a', 'token-b'])
  })

  it('refuses a write that names a lineage no longer in the pool', async () => {
    // A caller holding an account that has since been removed must not silently write
    // somewhere else: that is the fence the single-record store enforces too.
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    const state = await store.readPool()
    const refused = await store.compareAndCommit(
      state.revision,
      { refreshToken: 'token-x', projectId: 'p', lineage: 'does-not-exist' },
      'does-not-exist',
    )
    expect(refused).toBeUndefined()
    expect((await store.readPool()).accounts).toHaveLength(1)
  })

  it('replaces the active account when neither the caller nor the draft names a lineage', async () => {
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })
    const state = await store.readPool()
    const replaced = await store.compareAndCommit(state.revision, { refreshToken: 'token-rewritten', projectId: 'p' }, undefined)
    expect(replaced).toBeDefined()
    const after = await store.readPool()
    // The pool did not grow: this path is the single-record compatibility shape.
    expect(after.accounts).toHaveLength(2)
    expect(after.accounts.some(account => account.refreshToken === 'token-rewritten')).toBe(true)
  })

  it('rejects a compareAndCommit whose revision moved', async () => {
    const store = createAuthStorePool(await poolPath())
    await store.compareAndCommit(0, { refreshToken: 'token-a', projectId: 'project-a' }, undefined)
    const stale = await store.compareAndCommit(0, { refreshToken: 'token-stale', projectId: 'project-a' }, undefined)
    expect(stale).toBeUndefined()
    expect((await store.readPool()).accounts).toHaveLength(1)
  })

  it('clears only the current account on clearIfCurrent, keeping the rest of the pool', async () => {
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })
    expect((await store.readPool()).accounts).toHaveLength(2)

    const current = await store.read()
    const cleared = await store.clearIfCurrent(current?.revision ?? 0, current?.lineage)
    expect(cleared).toBe(true)
    const remaining = await store.readPool()
    expect(remaining.accounts).toHaveLength(1)
    expect(remaining.accounts[0]?.refreshToken).not.toBe(current?.refreshToken)
  })

  it('drops the whole pool on clear', async () => {
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })
    await store.clear()
    expect(await store.read()).toBeUndefined()
  })

  it('rotates the cursor forward on markCooldown and reports remaining ready accounts', async () => {
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })
    expect(await store.readyCount()).toBe(2)

    const pool = await store.readPool()
    await store.markCooldown(pool.accounts[0]?.lineage ?? '', 60_000)
    expect(await store.readyCount()).toBe(1)

    // The cooling account must not be selected while a ready one exists.
    const active = await store.read()
    expect(active?.refreshToken).not.toBe('token-a')
  })

  it('scans past a cooling account even when the cursor points at it', async () => {
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })
    const pool = await store.readPool()
    // Cool the account the cursor currently points at.
    const cursorAccount = pool.accounts[pool.activeIndex]
    await store.markCooldown(cursorAccount?.lineage ?? '', 60_000)
    const active = await store.read()
    expect(active?.lineage).not.toBe(cursorAccount?.lineage)
  })

  it('keeps independent cursors per model family', async () => {
    const poolPathValue = await poolPath()
    let requestedFamily: string | undefined = 'gemini'
    const store = createAuthStorePool(poolPathValue, { family: () => requestedFamily })
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })

    // Gemini cools the account it is pointed at. Only Gemini's cursor is recorded;
    // reading is side-effect free, so Claude has no cursor of its own yet.
    const geminiActive = await store.read()
    await store.markCooldown(geminiActive?.lineage ?? '', 60_000, 'gemini')
    const afterGemini = await store.readPool()
    expect(afterGemini.accounts.find(account => account.lineage === geminiActive?.lineage)?.cooldownUntil).toBeDefined()
    expect(afterGemini.activeIndexByFamily?.['gemini']).toBeDefined()
    expect(afterGemini.activeIndexByFamily?.['claude']).toBeUndefined()

    // Gemini, having rotated, now resolves to the other account.
    expect((await store.read())?.lineage).not.toBe(geminiActive?.lineage)

    // Claude established its own cursor by rotating it, and that cursor is independent
    // of Gemini's: it is what proves a Gemini-only exhaustion never rotates Claude.
    const claudeTarget = await store.read()
    await store.markCooldown(claudeTarget?.lineage ?? '', 60_000, 'claude')
    const claudeCursor = (await store.readPool()).activeIndexByFamily?.['claude']
    expect(claudeCursor).toBeDefined()

    // Cooling for Gemini afterwards must not disturb the cursor Claude owns.
    await store.markCooldown(geminiActive?.lineage ?? '', 60_000, 'gemini')
    expect((await store.readPool()).activeIndexByFamily?.['claude']).toBe(claudeCursor)
  })

  it('scopes a family cursor so another family still follows the pool cursor', async () => {
    const poolPathValue = await poolPath()
    let requestedFamily: string | undefined = 'gemini'
    const store = createAuthStorePool(poolPathValue, { family: () => requestedFamily })
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })

    await store.markCooldown('nonexistent-lineage', 60_000, 'gemini')
    // Only Gemini recorded a cursor; Claude has none and therefore inherits the pool's.
    const pool = await store.readPool()
    expect(pool.activeIndexByFamily?.['gemini']).toBeDefined()
    expect(pool.activeIndexByFamily?.['claude']).toBeUndefined()
    requestedFamily = 'claude'
    expect((await store.read())?.lineage).toBe(pool.accounts[pool.activeIndex]?.lineage)
  })

  it('cools the account for every family when no family is named', async () => {
    const poolPathValue = await poolPath()
    let requestedFamily: string | undefined = 'gemini'
    const store = createAuthStorePool(poolPathValue, { family: () => requestedFamily })
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })

    requestedFamily = 'gemini'
    const geminiBefore = await store.read()
    requestedFamily = 'claude'
    const claudeBefore = await store.read()
    expect(claudeBefore?.lineage).toBe(geminiBefore?.lineage)

    await store.markCooldown(geminiBefore?.lineage ?? '', 60_000)
    // Both families hold their own cursor at the cooling account, so both scan past it.
    requestedFamily = 'gemini'
    expect((await store.read())?.lineage).not.toBe(geminiBefore?.lineage)
    requestedFamily = 'claude'
    expect((await store.read())?.lineage).not.toBe(claudeBefore?.lineage)
  })

  it('clears the cooldown after the account is written successfully', async () => {
    const store = createAuthStorePool(await poolPath())
    const created = await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    const createdLineage = created.lineage ?? ''
    await store.markCooldown(createdLineage, 60_000)
    expect((await store.readPool()).accounts[0]?.cooldownUntil).toBeDefined()

    await store.commit({ refreshToken: 'token-a', projectId: 'project-a', lineage: createdLineage })
    const pool = await store.readPool()
    expect(pool.accounts[0]?.cooldownUntil).toBeUndefined()
    expect(pool.accounts[0]?.consecutiveFailures).toBeUndefined()
  })

  it('accumulates consecutive failures across cooldowns', async () => {
    const store = createAuthStorePool(await poolPath())
    const created = await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.markCooldown(created.lineage ?? '', 1_000)
    await store.markCooldown(created.lineage ?? '', 1_000)
    expect((await store.readPool()).accounts[0]?.consecutiveFailures).toBe(2)
  })

  it('removes one account without touching the others', async () => {
    const store = createAuthStorePool(await poolPath())
    await store.commit({ refreshToken: 'token-a', projectId: 'project-a' })
    await store.commit({ refreshToken: 'token-b', projectId: 'project-b' })
    const pool = await store.readPool()
    const removed = await store.removeAccount(pool.accounts[0]?.lineage ?? '')
    expect(removed).toBe(true)
    expect((await store.readPool()).accounts.map(account => account.refreshToken)).toEqual(['token-b'])
    // Removing an unknown lineage is a no-op, not an error.
    expect(await store.removeAccount('missing-lineage')).toBe(false)
  })

  it('receives a legacy single-record login through the plain store interface', async () => {
    // A caller written against the single-record API must keep working unchanged.
    const store = createAuthStorePool(await poolPath())
    const committed = await store.commit({ refreshToken: 'token-a', projectId: 'project-a', email: 'user@example.com' })
    expect(committed.refreshToken).toBe('token-a')
    // The persisted address is masked, and identity is a hash, so the raw address never
    // reaches the file.
    expect(committed.email).toBe('u***@example.com')
    expect(committed.lineage).toBeDefined()
    const read = await store.read()
    expect(read?.projectId).toBe('project-a')
  })

  it('rejects a corrupt pool file', async () => {
    const path = await poolPath()
    await writeFile(path, '{ not json', 'utf8')
    const store = createAuthStorePool(path)
    await expect(store.read()).rejects.toBeInstanceOf(AuthStoreError)
  })

  it('rejects an unsupported pool version', async () => {
    const path = await poolPath()
    await writeFile(path, JSON.stringify({ version: 99, accounts: [], activeIndex: 0 }), 'utf8')
    const store = createAuthStorePool(path)
    await expect(store.read().catch(error => (error as AuthStoreError).code))
      .resolves.toBe('AUTH_STORE_UNSUPPORTED_VERSION')
  })

  it('rejects a pool with a malformed account entry', async () => {
    const path = await poolPath()
    await writeFile(path, JSON.stringify({
      version: AUTH_POOL_VERSION,
      accounts: [{ refreshToken: '', projectId: 'p', lineage: 'l' }],
      activeIndex: 0,
    }), 'utf8')
    const store = createAuthStorePool(path)
    await expect(store.read().catch(error => (error as AuthStoreError).code))
      .resolves.toBe('AUTH_STORE_CORRUPT')
  })

  it('clamps an out-of-range activeIndex instead of failing', async () => {
    const path = await poolPath()
    await writeFile(path, JSON.stringify({
      version: AUTH_POOL_VERSION,
      accounts: [{ refreshToken: 'token-a', projectId: 'p', lineage: 'l', addedAt: new Date(0).toISOString() }],
      activeIndex: 57,
    }), 'utf8')
    const pool = await readPoolFile(path)
    expect(pool.activeIndex).toBe(0)
  })

  it('deduplicates repeated lineages on read', async () => {
    const path = await poolPath()
    await writeFile(path, JSON.stringify({
      version: AUTH_POOL_VERSION,
      accounts: [
        { refreshToken: 'token-a', projectId: 'p', lineage: 'same', addedAt: new Date(0).toISOString() },
        { refreshToken: 'token-b', projectId: 'p', lineage: 'same', addedAt: new Date(0).toISOString() },
      ],
      activeIndex: 0,
    }), 'utf8')
    const pool = await readPoolFile(path)
    expect(pool.accounts).toHaveLength(1)
    expect(pool.accounts[0]?.refreshToken).toBe('token-a')
  })

  it('writes a durable file that round-trips', async () => {
    const path = await poolPath()
    const pool: AuthPoolFile = {
      version: AUTH_POOL_VERSION,
      accounts: [{ refreshToken: 'token-a', projectId: 'project-a', lineage: 'l1', addedAt: new Date(0).toISOString() }],
      activeIndex: 0,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    }
    await writePoolFile(path, pool)
    const text = await readFile(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect((await readPoolFile(path)).accounts).toHaveLength(1)
  })

  it('survives concurrent commits without losing an account', async () => {
    const store = createAuthStorePool(await poolPath())
    // Mutations are serialized by the pool lock; all three must land.
    await Promise.all([
      store.commit({ refreshToken: 'token-a', projectId: 'p' }),
      store.commit({ refreshToken: 'token-b', projectId: 'p' }),
      store.commit({ refreshToken: 'token-c', projectId: 'p' }),
    ])
    expect((await store.readPool()).accounts).toHaveLength(3)
  })

  describe('legacy migration', () => {
    it('adopts a legacy record into an empty pool without changing its identity', () => {
      const adopted = migrateLegacyRecord(
        { version: AUTH_POOL_VERSION, accounts: [], activeIndex: 0, revision: 0, updatedAt: new Date(0).toISOString() },
        record({ lineage: 'legacy-lineage', email: 'user@example.com' }),
      )
      expect(adopted.accounts).toHaveLength(1)
      expect(adopted.accounts[0]?.lineage).toBe('legacy-lineage')
      expect(adopted.accounts[0]?.email).toBe('user@example.com')
      expect(adopted.accounts[0]?.refreshToken).toBe('refresh-token-placeholder')
    })

    it('is idempotent for an already-adopted lineage', () => {
      const pool: AuthPoolFile = {
        version: AUTH_POOL_VERSION,
        accounts: [{ refreshToken: 'legacy', projectId: 'p', lineage: 'legacy-lineage', addedAt: new Date(0).toISOString() }],
        activeIndex: 0,
        revision: 1,
        updatedAt: new Date(0).toISOString(),
      }
      const again = migrateLegacyRecord(pool, record({ lineage: 'legacy-lineage' }))
      expect(again.accounts).toHaveLength(1)
    })

    it('reads a single-record store and a pool store from sibling paths', async () => {
      const legacyPath = join(await poolPath(), '..', `${Math.random().toString(36).slice(2)}.json`)
      const legacy = createAuthStore(legacyPath)
      const written = await legacy.commit({ refreshToken: 'token-legacy', projectId: 'project-legacy' })
      const poolFilePath = defaultAuthPoolPath(legacyPath)
      expect(await readPoolFile(poolFilePath)).toEqual(expect.objectContaining({ accounts: [] }))

      await writePoolFile(poolFilePath, migrateLegacyRecord(await readPoolFile(poolFilePath), written))
      const store = createAuthStorePool(poolFilePath)
      const active = await store.read()
      expect(active?.lineage).toBe(written.lineage)
      expect(active?.refreshToken).toBe('token-legacy')
    })
  })

  it('defaults the pool path next to the auth store', () => {
    const resolved = defaultAuthPoolPath(join('C:', 'data', 'dsh-tool-antigravity', 'auth.json'))
    expect(resolved.endsWith(join('dsh-tool-antigravity', 'accounts.json'))).toBe(true)
  })
})

async function currentRevision(store: { read(): Promise<AntigravityAuthRecord | undefined> }): Promise<number> {
  return (await store.read())?.revision ?? 0
}
