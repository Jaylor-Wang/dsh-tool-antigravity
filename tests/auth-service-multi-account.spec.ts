/**
 * Multi-account wiring on the auth service: the pool is opt-in, rotation decisions
 * reach the pool, and the single-account default is left byte-for-byte unchanged.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAntigravityAuthService } from '../src/auth-service.ts'
import { createMemoryCapabilityGates } from '../src/capability-gates.ts'
import { createMemoryAuthStore } from '../src/auth-store.ts'
import { readPoolFile } from '../src/auth-store-pool.ts'

const directories: string[] = []

async function serviceDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agy-svc-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function makeService(storePath: string, multiAccount: boolean) {
  return createAntigravityAuthService({
    storePath,
    multiAccount,
    gates: createMemoryCapabilityGates(),
  })
}

describe('multi-account auth service wiring', () => {
  it('defaults to the single-record store and never creates a pool file', async () => {
    const directory = await serviceDir()
    const storePath = join(directory, 'auth.json')
    const service = makeService(storePath, false)

    expect(await service.accountCount()).toBe(0)
    // The service must not have created any file just by being constructed.
    await expect(readFile(storePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(directory, 'accounts.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports one account for a signed-in single-record store', async () => {
    const directory = await serviceDir()
    const storePath = join(directory, 'auth.json')
    // Seed a record the way a completed login would.
    const seed = createMemoryAuthStore()
    const record = await seed.commit({ refreshToken: 'token-a', projectId: 'p' })
    const service = createAntigravityAuthService({
      storePath,
      store: {
        read: async () => record,
        commit: async () => record,
        compareAndCommit: async () => record,
        clearIfCurrent: async () => true,
        clear: async () => {},
      },
      gates: createMemoryCapabilityGates(),
    })
    expect(await service.accountCount()).toBe(1)
    expect(await service.readyAccountCount()).toBe(1)
  })

  it('uses the pool when multiAccount is enabled', async () => {
    const directory = await serviceDir()
    const storePath = join(directory, 'auth.json')
    const service = makeService(storePath, true)
    // An empty pool reads as zero accounts, matching the absent-file semantics.
    expect(await service.accountCount()).toBe(0)

    // Seed the pool directly, since a login would need the full OAuth flow.
    const { createAuthStorePool } = await import('../src/auth-store-pool.ts')
    const pool = createAuthStorePool(join(directory, 'accounts.json'))
    await pool.commit({ refreshToken: 'token-a', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p' })

    expect(await service.accountCount()).toBe(2)
    expect(await service.readyAccountCount()).toBe(2)
  })

  it('rotates the pool on a quota failure and reports exhaustion at the end', async () => {
    const directory = await serviceDir()
    const storePath = join(directory, 'auth.json')
    const service = makeService(storePath, true)
    const { createAuthStorePool } = await import('../src/auth-store-pool.ts')
    const pool = createAuthStorePool(join(directory, 'accounts.json'))
    await pool.commit({ refreshToken: 'token-a', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p' })

    // Account A is exhausted: the pool rests it and points at B.
    expect(await service.rotateOnFailure({ status: 429, family: 'gemini' })).toBe('rotate')
    expect(await service.readyAccountCount()).toBe(1)

    // Account B is exhausted too: nothing is left ready.
    expect(await service.rotateOnFailure({ status: 429, family: 'gemini' })).toBe('exhausted')
    expect(await service.readyAccountCount()).toBe(0)
  })

  it('does not rest any account on a provider capacity failure', async () => {
    const directory = await serviceDir()
    const storePath = join(directory, 'auth.json')
    const service = makeService(storePath, true)
    const { createAuthStorePool } = await import('../src/auth-store-pool.ts')
    const pool = createAuthStorePool(join(directory, 'accounts.json'))
    await pool.commit({ refreshToken: 'token-a', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p' })

    expect(await service.rotateOnFailure({ status: 503, family: 'gemini' })).toBe('stay')
    expect(await service.readyAccountCount()).toBe(2)
  })

  it('reports relogin for a dead grant without resting any account', async () => {
    const directory = await serviceDir()
    const storePath = join(directory, 'auth.json')
    const service = makeService(storePath, true)
    const { createAuthStorePool } = await import('../src/auth-store-pool.ts')
    const pool = createAuthStorePool(join(directory, 'accounts.json'))
    await pool.commit({ refreshToken: 'token-a', projectId: 'p' })

    expect(await service.rotateOnFailure({ status: 400, message: 'invalid_grant', family: 'gemini' })).toBe('relogin')
    expect(await service.readyAccountCount()).toBe(1)
  })

  it('degrades to stay/relogin advice with the single-record store', async () => {
    const directory = await serviceDir()
    const storePath = join(directory, 'auth.json')
    const seed = createMemoryAuthStore()
    const record = await seed.commit({ refreshToken: 'token-a', projectId: 'p' })
    const service = createAntigravityAuthService({
      storePath,
      store: {
        read: async () => record,
        commit: async () => record,
        compareAndCommit: async () => record,
        clearIfCurrent: async () => true,
        clear: async () => {},
      },
      gates: createMemoryCapabilityGates(),
    })

    // There is nowhere to rotate to, so the advice must not claim otherwise.
    expect(await service.rotateOnFailure({ status: 429 })).toBe('rotate')
    expect(await service.readyAccountCount()).toBe(1)
    expect(await service.rotateOnFailure({ status: 503 })).toBe('stay')
    expect(await service.rotateOnFailure({ status: 401 })).toBe('relogin')
    // No pool file was created by any of that.
    await expect(readPoolFile(join(directory, 'accounts.json')))
      .resolves.toEqual(expect.objectContaining({ accounts: [] }))
  })
})
