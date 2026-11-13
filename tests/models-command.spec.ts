import { describe, expect, it, vi } from 'vitest'
import { createAntigravityModelsCommand } from '../src/models-command.ts'
import type { LoopbackRpcMode } from '../src/loopback-rpc.ts'
import type { AntigravityModelCatalogService, AntigravityModelCatalogView } from '../src/model-catalog.ts'
import type { AntigravityStatusView } from '../src/status.ts'

function idleStatus(): AntigravityStatusView {
  return {
    pluginId: 'dsh-tool-antigravity',
    phase: 'bootstrap',
    privateSelfUse: true,
    singleAccount: true,
    riskAcknowledgementRequired: true,
    riskAcknowledged: false,
    login: { phase: 'idle', configured: false, projectAvailable: false },
    accounts: [],
    capabilities: [],
  }
}

function readyStatus(): AntigravityStatusView {
  return {
    pluginId: 'dsh-tool-antigravity',
    phase: 'bootstrap',
    privateSelfUse: true,
    singleAccount: true,
    riskAcknowledgementRequired: true,
    riskAcknowledged: true,
    login: { phase: 'success', configured: true, projectAvailable: true },
    accounts: [],
    capabilities: [{ id: 'auth-llm', state: 'available', reasonCode: 'capability-ready' }],
  }
}

const SNAPSHOT_VIEW: AntigravityModelCatalogView = {
  state: 'snapshot',
  models: [
    { id: 'antigravity-gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', state: 'snapshot' },
    { id: 'antigravity-gemini-3.8-flash', name: 'Gemini 3.8 Flash', state: 'snapshot' },
  ],
}

const LIVE_VIEW: AntigravityModelCatalogView = {
  state: 'live-available',
  checkedAt: '2026-11-13T10:00:00.000Z',
  models: [
    { id: 'antigravity-gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', state: 'live-available' },
    { id: 'antigravity-gemini-4-carbon', name: 'Gemini 4 Carbon', state: 'unavailable' },
  ],
}

function makeHarness(options?: {
  status?: AntigravityStatusView
  view?: AntigravityModelCatalogView
  mode?: LoopbackRpcMode
  throwCatalog?: Error
}) {
  const statusFn = vi.fn(async () => options?.status ?? readyStatus())
  const catalogSnapshot = vi.fn(() => SNAPSHOT_VIEW)
  const modelCatalog = vi.fn(async () => {
    if (options?.throwCatalog) throw options.throwCatalog
    return options?.view ?? LIVE_VIEW
  })
  const catalog: AntigravityModelCatalogService = {
    catalogSnapshot,
    modelCatalog,
  }
  const onUpdated = vi.fn()
  const mode = options?.mode ?? 'enabled'
  const command = createAntigravityModelsCommand({ status: statusFn }, catalog, () => mode, onUpdated)
  return { command, statusFn, catalogSnapshot, modelCatalog, onUpdated }
}

describe('Antigravity models slash command', () => {
  it('force-refreshes live models by default and notifies DSH of catalog updates', async () => {
    const { command, modelCatalog, onUpdated } = makeHarness()
    const signal = new AbortController().signal

    const result = await command.handler({ rawInput: '', signal } as never)

    expect(modelCatalog).toHaveBeenCalledExactlyOnceWith(signal, true)
    expect(onUpdated).toHaveBeenCalledOnce()
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('refreshed (live')
      expect(result.text).toContain('1 available (1 unavailable filtered)')
      expect(result.text).toContain('- antigravity-gemini-4-hydrogen (Gemini 4 Hydrogen)')
      expect(result.text).not.toContain('antigravity-gemini-4-carbon')
    }
  })

  it('supports explicit refresh and non-forcing list subcommands', async () => {
    const refreshHarness = makeHarness()
    await refreshHarness.command.handler({ rawInput: ' refresh ' } as never)
    expect(refreshHarness.modelCatalog).toHaveBeenCalledExactlyOnceWith(undefined, true)
    expect(refreshHarness.onUpdated).toHaveBeenCalledOnce()

    const listHarness = makeHarness()
    const listResult = await listHarness.command.handler({ rawInput: 'list' } as never)
    expect(listHarness.modelCatalog).toHaveBeenCalledExactlyOnceWith(undefined, false)
    expect(listHarness.onUpdated).not.toHaveBeenCalled()
    expect(listResult.kind).toBe('success')
    if (listResult.kind === 'success') {
      expect(listResult.text).toContain('Antigravity models (live')
    }
  })

  it('returns snapshot warning without contacting the server when Gate 0/LLM is not ready', async () => {
    const { command, catalogSnapshot, modelCatalog, onUpdated } = makeHarness({ status: idleStatus() })

    const result = await command.handler({ rawInput: '' } as never)

    expect(catalogSnapshot).toHaveBeenCalledOnce()
    expect(modelCatalog).not.toHaveBeenCalled()
    expect(onUpdated).not.toHaveBeenCalled()
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('login or Gate 0 not ready')
      expect(result.text).toContain('列表可能不是最新')
      expect(result.text).toContain('antigravity-gemini-4-hydrogen')
    }
  })

  it.each([
    { state: 'refresh-failed' as const, cached: true, expectedSource: 'cached fallback' },
    { state: 'protocol-drift' as const, cached: false, expectedSource: 'known snapshot fallback' },
  ])('warns that the list may not be up to date on $state fallback', async ({ state, cached, expectedSource }) => {
    const { command, onUpdated } = makeHarness({
      view: {
        state,
        cached,
        checkedAt: '2026-11-13T10:05:00.000Z',
        models: [{ id: 'antigravity-gemini-3.8-flash', name: 'Gemini 3.8 Flash', state: 'snapshot' }],
      },
    })

    const result = await command.handler({ rawInput: 'refresh' } as never)

    expect(onUpdated).toHaveBeenCalledOnce()
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain(state)
      expect(result.text).toContain(expectedSource)
      expect(result.text).toContain('the model list may not be up to date')
      expect(result.text).toContain('列表可能不是最新')
      expect(result.text).toContain('antigravity-gemini-3.8-flash')
    }
  })

  it('rejects unknown operations and denies execution on public-Web compositions', async () => {
    const blocked = makeHarness({ mode: 'blocked' })
    await expect(blocked.command.handler({ rawInput: '' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'Antigravity account commands require a local DSH Host (no WebServer or 127.0.0.1-bound)',
    })
    expect(blocked.statusFn).not.toHaveBeenCalled()
    expect(blocked.modelCatalog).not.toHaveBeenCalled()
    expect(blocked.onUpdated).not.toHaveBeenCalled()

    const badOp = makeHarness()
    await expect(badOp.command.handler({ rawInput: 'bogus' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'unknown operation "bogus" (available: refresh, list)',
    })
  })

  it('surfaces catalog exceptions cleanly as command errors', async () => {
    const { command, onUpdated } = makeHarness({ throwCatalog: new Error('disk locked') })

    await expect(command.handler({ rawInput: '' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'refreshing Antigravity models failed: disk locked',
    })
    expect(onUpdated).not.toHaveBeenCalled()
  })
})
