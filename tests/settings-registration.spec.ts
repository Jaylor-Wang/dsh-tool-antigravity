import { describe, expect, it, vi } from 'vitest'
import {
  Config as ImageConfig,
  apply as applyImage,
} from '../src/image.ts'
import { createStatusView } from '../src/status.ts'

function bench() {
  const configure = vi.fn()
  const on = vi.fn()
  const auth = {
    status: vi.fn(async () => createStatusView(false, {
      phase: 'idle',
      configured: false,
      projectAvailable: false,
    })),
    watchStatus: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
  }
  const ctx = {
    fiber: { uid: 1 },
    tools: { register: vi.fn() },
    attachments: {},
    fs: {},
    get: vi.fn(() => auth),
    on,
    inject: vi.fn((dependencies: readonly string[], callback: (injected: unknown) => unknown) => {
      if (dependencies.length === 1 && dependencies[0] === 'settings') {
        return callback({ settings: { configure } })
      }
      return undefined
    }),
    effect: vi.fn((setup: () => () => Promise<void>) => setup()),
  }
  return { ctx, configure, on }
}

describe('Host Settings registration', () => {
  it('declares enabled as a volatile schema field for DSH dynamic settings', () => {
    expect((ImageConfig.dict as any)?.enabled?.meta?.volatile).toBe(true)
  })

  it('configures settings presentation with auto: false and subscribes to volatile-update', () => {
    const { ctx, configure, on } = bench()
    const config = { enabled: true, model: 'antigravity-gemini-3.1-flash-image', n: 1 }

    applyImage(ctx as never, config)

    expect(configure).toHaveBeenCalledOnce()
    expect(configure).toHaveBeenCalledWith({ auto: false }, ctx.fiber)
    expect(on).toHaveBeenCalledWith('loader/volatile-update', expect.any(Function))
  })
})
