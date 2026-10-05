import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyProxySetting,
  getStoredProxy,
  setStoredProxy,
  setCustomProxyConfigFile,
} from '../src/proxy-config.ts'
import { setExplicitProxy, scopedHttpsFetch } from '../src/private-transport.ts'

describe('proxy configuration and process isolation', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-proxy-unit-'))
    setCustomProxyConfigFile(join(tempDir, 'config.json'))
    setExplicitProxy(undefined)
  })

  afterEach(async () => {
    setExplicitProxy(undefined)
    setCustomProxyConfigFile(undefined)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('stores and retrieves proxy configuration', () => {
    expect(getStoredProxy()).toBe('')
    setStoredProxy('http://127.0.0.1:7890')
    expect(getStoredProxy()).toBe('http://127.0.0.1:7890')
    setStoredProxy('')
    expect(getStoredProxy()).toBe('')
  })

  it('applies proxy without touching global dispatcher or polluting global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // Applying proxy setting should NOT throw or set global dispatcher
    applyProxySetting('http://127.0.0.1:7890')

    // Scoped fetch with NO_PROXY matching should fall back to globalThis.fetch
    process.env.NO_PROXY = 'example.com'
    fetchSpy.mockImplementationOnce(async () => new Response('ok', { status: 200 }))
    const res = await scopedHttpsFetch('https://example.com')
    expect(await res.text()).toBe('ok')
    expect(fetchSpy).toHaveBeenCalledOnce()

    // Clearing proxy setting should NOT throw or touch global dispatcher
    applyProxySetting('')
    delete process.env.NO_PROXY
  })
})
