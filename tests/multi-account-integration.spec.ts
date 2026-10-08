/**
 * The A+B+C integration: signing in as a second account joins the pool, an existing
 * single-account install is adopted without being rewritten, and a real refresh failure
 * drives the coordinator to rotate onto the next account with no user action.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAntigravityAuthService } from '../src/auth-service.ts'
import { createAuthStore } from '../src/auth-store.ts'
import { createAuthStorePool, emailTagFor, readPoolFile } from '../src/auth-store-pool.ts'
import { createMemoryCapabilityGates } from '../src/capability-gates.ts'
import { CredentialOperationError } from '../src/credential-coordinator.ts'
import { AntigravityAdapter } from '../src/llm-adapter.ts'
const directories: string[] = []

async function workspace(): Promise<{ directory: string; storePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'agy-abc-'))
  directories.push(directory)
  return { directory, storePath: join(directory, 'auth.json') }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/**
 * Drive a login through the real service. `startLogin` + `completeCallback` need the full
 * OAuth loopback fixture, so the tests below reach `commitLogin` through the public
 * `compareAndCommit` seam the flow uses instead, keeping the assertions on store state.
 */
function serviceFor(storePath: string, credentials?: { onRefreshFailure?: unknown }) {
  return createAntigravityAuthService({
    storePath,
    multiAccount: true,
    gates: createMemoryCapabilityGates(),
    ...(credentials === undefined ? {} : { credentialOptions: credentials as never }),
  })
}

describe('A: a second login joins the pool instead of replacing the first', () => {
  it('appends when commitLogin is given an address the pool has never seen', async () => {
    // `commitLogin` is private, so exercise the exact call shape it produces for an unknown
    // account: a fresh lineage in the draft, and no observed lineage. A blank lineage with
    // no draft lineage would instead replace the active account, which was the bug.
    const { directory } = await workspace()
    const poolPath = join(directory, 'accounts.json')
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-adopted', projectId: 'p' })

    const before = await pool.readPool()
    const freshLineage = randomUUID()
    const appended = await pool.compareAndCommit(
      before.revision,
      { refreshToken: 'token-second', projectId: 'p', email: 'second@example.com', lineage: freshLineage },
      undefined,
    )
    expect(appended).toBeDefined()
    expect(appended?.lineage).toBe(freshLineage)

    const after = await readPoolFile(poolPath)
    expect(after.accounts).toHaveLength(2)
    expect(after.accounts.map(account => account.refreshToken)).toEqual(['token-adopted', 'token-second'])
  })

  it('keeps both accounts when two different addresses sign in', async () => {
    const { directory, storePath } = await workspace()
    const pool = createAuthStorePool(join(directory, 'accounts.json'))
    const service = serviceFor(storePath)

    await pool.commit({ refreshToken: 'token-alpha', projectId: 'p', email: 'alpha@example.com' })
    await pool.commit({ refreshToken: 'token-bravo', projectId: 'p', email: 'bravo@example.com' })
    expect(await service.accountCount()).toBe(2)

    const state = await readPoolFile(join(directory, 'accounts.json'))
    // Both entries are present, each with its own identity tag and masked display form.
    expect(state.accounts).toHaveLength(2)
    expect(state.accounts.map(account => account.emailTag)).toEqual([
      emailTagFor('alpha@example.com'),
      emailTagFor('bravo@example.com'),
    ])
    expect(state.accounts.every(account => account.emailTag !== undefined)).toBe(true)
  })

  it('never persists a plaintext address, even in the pool', async () => {
    const { directory } = await workspace()
    const poolPath = join(directory, 'accounts.json')
    await createAuthStorePool(poolPath).commit({ refreshToken: 't', projectId: 'p', email: 'alice@example.com' })
    const raw = await readFile(poolPath, 'utf8')
    // The same privacy contract the single-record store is held to.
    expect(raw).not.toContain('alice@example.com')
    const state = await readPoolFile(poolPath)
    expect(state.accounts[0]?.email).toBe('a***@example.com')
    expect(state.accounts[0]?.emailTag).toBe(emailTagFor('alice@example.com'))
  })

  it('gives the same identity tag regardless of address casing', async () => {
    // Signing in as "Alice@Example.com" must refresh the same account, not add one.
    expect(emailTagFor('Alice@Example.com')).toBe(emailTagFor('alice@example.com'))
  })

  it('masks an address that carries no usable local part', async () => {
    const { directory } = await workspace()
    const poolPath = join(directory, 'accounts.json')
    await createAuthStorePool(poolPath).commit({ refreshToken: 't', projectId: 'p', email: '@example.com' })
    const state = await readPoolFile(poolPath)
    expect(state.accounts[0]?.email).toBe('***')
    // No local part means no stable identity, so no tag is derived.
    expect(state.accounts[0]?.emailTag).toBeUndefined()
  })
})

describe('B: an existing single-account install is adopted without being rewritten', () => {
  it('serves the legacy account while the pool is empty', async () => {
    const { directory, storePath } = await workspace()
    // A pre-existing install: one account in auth.json, no pool file.
    const legacy = createAuthStore(storePath)
    const written = await legacy.commit({ refreshToken: 'token-legacy', projectId: 'project-legacy', email: 'user@example.com' })

    const pool = createAuthStorePool(join(directory, 'accounts.json'), { legacyStorePath: storePath })
    const active = await pool.read()
    expect(active?.refreshToken).toBe('token-legacy')
    expect(active?.lineage).toBe(written.lineage)
    expect(await pool.readyCount()).toBe(1)
  })

  it('leaves the legacy file byte-identical after reading it', async () => {
    const { directory, storePath } = await workspace()
    const legacy = createAuthStore(storePath)
    await legacy.commit({ refreshToken: 'token-legacy', projectId: 'p' })
    const before = await readFile(storePath, 'utf8')

    const pool = createAuthStorePool(join(directory, 'accounts.json'), { legacyStorePath: storePath })
    await pool.read()
    await pool.readPool()
    await pool.readyCount()

    expect(await readFile(storePath, 'utf8')).toBe(before)
    // And no pool file was created by reading alone.
    await expect(readFile(join(directory, 'accounts.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('carries the legacy account into the pool on the first real write', async () => {
    const { directory, storePath } = await workspace()
    const legacy = createAuthStore(storePath)
    await legacy.commit({ refreshToken: 'token-legacy', projectId: 'p', email: 'legacy@example.com' })

    const poolPath = join(directory, 'accounts.json')
    const pool = createAuthStorePool(poolPath, { legacyStorePath: storePath })
    await pool.commit({ refreshToken: 'token-new', projectId: 'p', email: 'new@example.com' })

    const state = await readPoolFile(poolPath)
    // The adopted account survived alongside the new one.
    expect(state.accounts.map(account => account.refreshToken).sort()).toEqual(['token-legacy', 'token-new'])
    // The legacy file is still there, untouched.
    expect(JSON.parse(await readFile(storePath, 'utf8')).refreshToken).toBe('token-legacy')
  })

  it('prefers the pool once it has accounts, ignoring the legacy file', async () => {
    const { directory, storePath } = await workspace()
    await (await createAuthStore(storePath)).commit({ refreshToken: 'token-legacy', projectId: 'p' })
    const poolPath = join(directory, 'accounts.json')
    await createAuthStorePool(poolPath).commit({ refreshToken: 'token-pool', projectId: 'p' })

    const pool = createAuthStorePool(poolPath, { legacyStorePath: storePath })
    expect((await pool.read())?.refreshToken).toBe('token-pool')
    expect(await pool.readyCount()).toBe(1)
  })

  it('ignores a corrupt legacy file instead of failing', async () => {
    const { directory, storePath } = await workspace()
    await writeFile(storePath, '{ this is not json', 'utf8')
    const pool = createAuthStorePool(join(directory, 'accounts.json'), { legacyStorePath: storePath })
    // A broken legacy file must not take the pool down with it.
    expect(await pool.read()).toBeUndefined()
  })
})

describe('C: a refresh failure rotates the pool through the real coordinator', () => {
  it('benches the failing account so the next read selects a different one', async () => {
    const { directory, storePath } = await workspace()
    const poolPath = join(directory, 'accounts.json')
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-alpha', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-bravo', projectId: 'p' })

    // The service wires its own rotation hook when the pool is active; passing one here
    // would be overwritten by that spread, so the test drives the service directly.
    const service = createAntigravityAuthService({
      storePath,
      multiAccount: true,
      gates: createMemoryCapabilityGates(),
    })
    expect(await service.accountCount()).toBe(2)

    const before = await pool.read()
    // The service owns the rotation decision; the pool is what it acts on.
    expect(await service.rotateOnFailure({ status: 429 })).toBe('rotate')
    const after = await pool.read()
    expect(after?.lineage).not.toBe(before?.lineage)
    expect(await pool.readyCount()).toBe(1)
  })

  it('leaves the pool alone on a capacity failure', async () => {
    const { directory, storePath } = await workspace()
    const poolPath = join(directory, 'accounts.json')
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-alpha', projectId: 'p' })
    await pool.commit({ refreshToken: 'token-bravo', projectId: 'p' })
    const service = createAntigravityAuthService({ storePath, multiAccount: true, gates: createMemoryCapabilityGates() })

    expect(await service.rotateOnFailure({ status: 503 })).toBe('stay')
    expect(await pool.readyCount()).toBe(2)
  })

  it('notifies the rotation hook when the coordinator records a refresh failure', async () => {
    const { directory, storePath } = await workspace()
    const reports: unknown[] = []
    const poolPath = join(directory, 'accounts.json')
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-alpha', projectId: 'p' })

    // Exercise the hook wiring directly: the coordinator calls it from setRefreshFailure.
    const { createCredentialCoordinator } = await import('../src/credential-coordinator.ts')
    const coordinator = createCredentialCoordinator({
      store: pool,
      refreshToken: async () => { throw new CredentialOperationError('rate-limited') },
      onRefreshFailure: report => { reports.push(report) },
    })
    const credential = await coordinator.credential()
    expect(credential).toBeUndefined()
    // The hook is fire-and-forget, so let the microtask queue drain.
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ message: 'rate-limited', status: 429 })
    await coordinator.dispose()
  })

  it('exposes the underlying credential error even when the rotation hook throws', async () => {
    const { directory } = await workspace()
    const poolPath = join(directory, 'accounts.json')
    const pool = createAuthStorePool(poolPath)
    await pool.commit({ refreshToken: 'token-alpha', projectId: 'p' })

    const { createCredentialCoordinator } = await import('../src/credential-coordinator.ts')
    const coordinator = createCredentialCoordinator({
      store: pool,
      refreshToken: async () => { throw new CredentialOperationError('rate-limited') },
      onRefreshFailure: () => { throw new Error('rotation hook exploded') },
    })
    // A broken hook must not mask the real failure.
    await expect(coordinator.credential()).resolves.toBeUndefined()
    expect((await coordinator.status()).errorCode).toBe('rate-limited')
    await coordinator.dispose()
  })

  it('does not create a pool file when multiAccount stays off', async () => {
    const { directory, storePath } = await workspace()
    const service = createAntigravityAuthService({
      storePath,
      multiAccount: false,
      gates: createMemoryCapabilityGates(),
    })
    // With no account signed in there is nothing to rotate and nothing to advise but a
    // fresh login, regardless of what failed.
    expect(await service.rotateOnFailure({ status: 429 })).toBe('relogin')
    expect(await service.accountCount()).toBe(0)
    await expect(readFile(join(directory, 'accounts.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('advises rotation on the single-record path without writing any pool state', async () => {
    const { directory, storePath } = await workspace()
    const service = createAntigravityAuthService({
      storePath,
      multiAccount: false,
      gates: createMemoryCapabilityGates(),
      store: {
        read: async () => ({
          version: 1 as const,
          refreshToken: 'token-a',
          projectId: 'p',
          revision: 1,
          updatedAt: new Date().toISOString(),
          lineage: 'lineage-a',
        }),
        commit: async () => { throw new Error('unused') },
        compareAndCommit: async () => undefined,
        clearIfCurrent: async () => true,
        clear: async () => {},
      },
    })
    // Signed in, but there is no pool: the advice is still "rotate" so a caller can decide,
    // yet nothing is persisted anywhere.
    expect(await service.rotateOnFailure({ status: 429 })).toBe('rotate')
    expect(await service.readyAccountCount()).toBe(1)
    await expect(readFile(join(directory, 'accounts.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('D: LLM 429 automatically rotates accounts and recovers generation', () => {
  it('switches from an exhausted account to the next ready account on 429 during stream', async () => {
    const { directory, storePath } = await workspace()
    const pool = createAuthStorePool(join(directory, 'accounts.json'))
    await pool.commit({ refreshToken: 'token-a', projectId: 'p', email: 'a@example.com' })
    await pool.commit({ refreshToken: 'token-b', projectId: 'p', email: 'b@example.com' })

    const service = createAntigravityAuthService({
      storePath,
      multiAccount: true,
      gates: createMemoryCapabilityGates(),
      credentialOptions: {
        refreshToken: async ({ refreshToken }) => ({
          accessToken: `access-for-${refreshToken}`,
          expiresAt: Date.now() + 3_600_000,
        }),
      },
    })

    const requests: string[] = []
    const transport = {
      request: vi.fn(async (input: { accessToken?: string }) => {
        const token = input.accessToken ?? ''
        requests.push(token)
        if (token === 'access-for-token-a') {
          return new Response('', { status: 429 })
        }
        return new Response('data: {"response":{"parts":[{"text":"hello from account b"}],"finishReason":"STOP"}}\n\n')
      }),
    }

    const adapter = new AntigravityAdapter({
      auth: service,
      transport,
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'google-antigravity',
      model: 'antigravity-gemini-3.7-flash',
      messages: [{
        id: 'msg-1' as never,
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      }],
    })) {
      chunks.push(chunk)
    }

    expect(requests).toEqual(['access-for-token-a', 'access-for-token-b'])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello from account b')).toBe(true)
    expect(await service.readyAccountCount()).toBe(1)
  })
})
