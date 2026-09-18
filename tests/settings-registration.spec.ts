import { describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_IMAGE_SETTINGS_NAMESPACE,
  Config as ImageConfig,
  apply as applyImage,
} from '../src/image.ts'
import { createStatusView } from '../src/status.ts'

function bench() {
  const installSection = vi.fn()
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
    tools: { register: vi.fn() },
    attachments: {},
    fs: {},
    get: vi.fn(() => auth),
    inject: vi.fn((dependencies: readonly string[], callback: (injected: unknown) => unknown) => {
      if (dependencies.length === 1 && dependencies[0] === 'settings') {
        return callback({ settings: { installSection } })
      }
      return undefined
    }),
    effect: vi.fn((setup: () => () => Promise<void>) => setup()),
  }
  return { ctx, installSection }
}

describe('Host Settings registration', () => {
  it('installs the image section through ctx.settings.installSection()', () => {
    const { ctx, installSection } = bench()
    const config = { enabled: true, model: 'antigravity-gemini-3.1-flash-image', n: 1 }

    applyImage(ctx as never, config)

    expect(installSection).toHaveBeenCalledOnce()
    expect(installSection).toHaveBeenCalledWith(
      ctx,
      ANTIGRAVITY_IMAGE_SETTINGS_NAMESPACE,
      ImageConfig,
      config,
      expect.objectContaining({
        setSource: expect.any(Function),
        onChange: expect.any(Function),
      }),
    )
  })
})
