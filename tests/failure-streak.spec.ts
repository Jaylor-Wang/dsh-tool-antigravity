/**
 * Failure-streak aging.
 *
 * The stored counter is only "consecutive" if it expires: an account that failed once, worked
 * for hours, then failed again has not failed twice in a row, and the backoff ladder it feeds
 * must not escalate as if it had.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTH_POOL_VERSION,
  FAILURE_STREAK_WINDOW_MS,
  createAuthStorePool,
  effectiveFailureCount,
  readPoolFile,
} from '../src/auth-store-pool.ts'

const directories: string[] = []

async function poolPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agy-streak-'))
  directories.push(directory)
  return join(directory, 'accounts.json')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('effectiveFailureCount', () => {
  const at = 1_700_000_000_000

  it('returns zero for a missing or empty counter', () => {
    expect(effectiveFailureCount({}, at)).toBe(0)
    expect(effectiveFailureCount({ consecutiveFailures: 0 }, at)).toBe(0)
  })

  it('keeps a recent streak', () => {
    expect(effectiveFailureCount({ consecutiveFailures: 3, lastFailureAt: at - 1_000 }, at)).toBe(3)
  })

  it('expires a streak older than the window', () => {
    const stale = at - FAILURE_STREAK_WINDOW_MS - 1
    expect(effectiveFailureCount({ consecutiveFailures: 5, lastFailureAt: stale }, at)).toBe(0)
  })

  it('treats the window boundary as still current', () => {
    const boundary = at - FAILURE_STREAK_WINDOW_MS
    expect(effectiveFailureCount({ consecutiveFailures: 2, lastFailureAt: boundary }, at)).toBe(2)
  })

  it('keeps an unanchored counter, so older pool files behave unchanged', () => {
    // A file written before `lastFailureAt` existed has no way to age out, and silently
    // discarding its count would change the ladder for an existing install.
    expect(effectiveFailureCount({ consecutiveFailures: 4 }, at)).toBe(4)
  })
})

describe('markCooldown records an anchor and ages the streak', () => {
  it('stamps the failure time', async () => {
    const store = createAuthStorePool(await poolPath(), { now: () => 1_700_000_000_000 })
    const created = await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    await store.markCooldown(created.lineage ?? '', 60_000)

    const account = (await store.readPool()).accounts[0]
    expect(account?.consecutiveFailures).toBe(1)
    expect(account?.lastFailureAt).toBe(1_700_000_000_000)
  })

  it('extends a streak that is still fresh', async () => {
    let clock = 1_700_000_000_000
    const store = createAuthStorePool(await poolPath(), { now: () => clock })
    const created = await store.commit({ refreshToken: 'token-a', projectId: 'p' })

    await store.markCooldown(created.lineage ?? '', 60_000)
    clock += 60_000
    await store.markCooldown(created.lineage ?? '', 60_000)
    clock += 60_000
    await store.markCooldown(created.lineage ?? '', 60_000)

    expect((await store.readPool()).accounts[0]?.consecutiveFailures).toBe(3)
  })

  it('restarts the streak after the window has elapsed', async () => {
    let clock = 1_700_000_000_000
    const store = createAuthStorePool(await poolPath(), { now: () => clock })
    const created = await store.commit({ refreshToken: 'token-a', projectId: 'p' })

    // Two quick failures, then a long healthy gap, then one more.
    await store.markCooldown(created.lineage ?? '', 60_000)
    clock += 60_000
    await store.markCooldown(created.lineage ?? '', 60_000)
    expect((await store.readPool()).accounts[0]?.consecutiveFailures).toBe(2)

    clock += FAILURE_STREAK_WINDOW_MS + 1
    await store.markCooldown(created.lineage ?? '', 60_000)
    // The third failure is the first of a new streak, not the third in a row.
    expect((await store.readPool()).accounts[0]?.consecutiveFailures).toBe(1)
  })

  it('clears the anchor when a write succeeds', async () => {
    const store = createAuthStorePool(await poolPath())
    const created = await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    const lineage = created.lineage ?? ''

    await store.markCooldown(lineage, 60_000)
    expect((await store.readPool()).accounts[0]?.lastFailureAt).toBeDefined()

    await store.commit({ refreshToken: 'token-a', projectId: 'p', lineage })
    const account = (await store.readPool()).accounts[0]
    expect(account?.consecutiveFailures).toBeUndefined()
    expect(account?.lastFailureAt).toBeUndefined()
  })

  it('leaves other accounts untouched', async () => {
    const store = createAuthStorePool(await poolPath())
    const first = await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    await store.commit({ refreshToken: 'token-b', projectId: 'p' })

    await store.markCooldown(first.lineage ?? '', 60_000)
    const untouched = (await store.readPool()).accounts.find(account => account.lineage !== first.lineage)
    expect(untouched?.consecutiveFailures).toBeUndefined()
    expect(untouched?.lastFailureAt).toBeUndefined()
  })
})

describe('pool file compatibility', () => {
  it('round-trips the anchor through the file', async () => {
    const path = await poolPath()
    const store = createAuthStorePool(path, { now: () => 1_700_000_000_000 })
    const created = await store.commit({ refreshToken: 'token-a', projectId: 'p' })
    await store.markCooldown(created.lineage ?? '', 60_000)

    const reloaded = await readPoolFile(path)
    expect(reloaded.accounts[0]?.lastFailureAt).toBe(1_700_000_000_000)
  })

  it('reads a file written before the anchor existed', async () => {
    const path = await poolPath()
    // Exactly the shape an older build wrote: a counter with no anchor.
    await writeFile(path, JSON.stringify({
      version: AUTH_POOL_VERSION,
      accounts: [{
        refreshToken: 'token-a',
        projectId: 'p',
        lineage: 'lineage-a',
        addedAt: new Date(0).toISOString(),
        consecutiveFailures: 3,
      }],
      activeIndex: 0,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    }), 'utf8')

    const pool = await readPoolFile(path)
    const account = pool.accounts[0]
    expect(account?.consecutiveFailures).toBe(3)
    expect(account?.lastFailureAt).toBeUndefined()
    // The unanchored counter is trusted, so an upgrade does not reset a live streak.
    expect(effectiveFailureCount(account ?? {}, Date.now())).toBe(3)
  })
})
