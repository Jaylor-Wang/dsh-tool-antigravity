import { describe, expect, it, vi } from 'vitest'
import { registerAntigravityPetBalance } from '../src/pet-balance.ts'
import type { AntigravityAuthService } from '../src/auth-service.ts'
import type { QuotaStatusView } from '../src/quota.ts'

describe('registerAntigravityPetBalance', () => {
  const MOCK_QUOTA: QuotaStatusView = {
    state: 'available',
    checkedAt: '2026-10-25T00:00:00.000Z',
    groups: [
      {
        group: 'gemini',
        modelCount: 5,
        windows: [
          { window: '5h', remainingFraction: 0.88, resetTime: '2026-10-25T05:00:00.000Z' },
          { window: 'weekly', remainingFraction: 0.94, resetTime: '2026-10-31T00:00:00.000Z' },
        ],
      },
      {
        group: 'non-gemini',
        modelCount: 2,
        windows: [
          { window: '5h', remainingFraction: 0.5, resetTime: '2026-10-25T06:00:00.000Z' },
          { window: 'weekly', remainingFraction: 0.35, resetTime: '2026-10-31T00:00:00.000Z' },
        ],
      },
    ],
  }

  it('registers google-antigravity balance provider into petApi7340', async () => {
    let registeredProvider: { id: string; fetch: (args: { provider: string }) => Promise<unknown> } | undefined
    const mockUnregister = vi.fn()

    const mockCtx = {
      inject: vi.fn((deps: string[], cb: (ctx: Record<string, unknown>) => unknown) => {
        if (deps.includes('petApi7340')) {
          cb({
            petApi7340: {
              balance: {
                register: vi.fn((def) => {
                  registeredProvider = def
                  return mockUnregister
                }),
              },
            },
          })
        }
      }),
      agentDefaultModel: {
        currentSelection: () => ({ model: 'gemini-2.5-pro' }),
      },
    }

    const mockService = {
      usage: vi.fn(async () => MOCK_QUOTA),
    } as unknown as AntigravityAuthService

    registerAntigravityPetBalance(mockCtx as never, mockService)
    expect(mockCtx.inject).toHaveBeenCalledWith(['petApi7340'], expect.any(Function))
    expect(registeredProvider?.id).toBe('google-antigravity')

    const res = (await registeredProvider!.fetch({ provider: 'google-antigravity' })) as {
      ok: boolean
      provider: string
      shape: string
      data: { views: unknown[]; percent: number }
    }

    expect(res.ok).toBe(true)
    expect(res.provider).toBe('google-antigravity')
    expect(res.shape).toBe('custom')
    expect(res.data.views).toHaveLength(2)
    // 5h 剩余 88% (已用 12%)，周剩余 94% (已用 6%)，最告急已用 12%
    expect(res.data.percent).toBe(12)

    // 第一页为 Gemini
    const page1Str = JSON.stringify(res.data.views[0])
    expect(page1Str).toContain('google-antigravity')
    expect(page1Str).toContain('Gemini')
    expect(page1Str).toContain('剩余 88%')
    expect(page1Str).toContain('剩余 94%')
  })

  it('prioritizes Claude / non-gemini group on page 1 when current model is Claude', async () => {
    let registeredProvider: { id: string; fetch: (args: { provider: string }) => Promise<unknown> } | undefined

    const mockCtx = {
      inject: vi.fn((deps: string[], cb: (ctx: Record<string, unknown>) => unknown) => {
        cb({
          petApi7340: {
            balance: {
              register: vi.fn((def) => {
                registeredProvider = def
                return () => {}
              }),
            },
          },
        })
      }),
      agentDefaultModel: {
        currentSelection: () => ({ model: 'claude-3-7-sonnet' }),
      },
    }

    const mockService = {
      usage: vi.fn(async () => MOCK_QUOTA),
    } as unknown as AntigravityAuthService

    registerAntigravityPetBalance(mockCtx as never, mockService)
    const res = (await registeredProvider!.fetch({ provider: 'google-antigravity' })) as {
      data: { views: unknown[]; percent: number }
    }

    // 第一页为 Claude
    const page1Str = JSON.stringify(res.data.views[0])
    expect(page1Str).toContain('Claude')
    expect(page1Str).toContain('剩余 50%')
    expect(page1Str).toContain('剩余 35%')
  })

  it('throws friendly error on unauthenticated quota', async () => {
    let registeredProvider: { id: string; fetch: (args: { provider: string }) => Promise<unknown> } | undefined

    const mockCtx = {
      inject: vi.fn((deps: string[], cb: (ctx: Record<string, unknown>) => unknown) => {
        cb({
          petApi7340: {
            balance: {
              register: vi.fn((def) => {
                registeredProvider = def
                return () => {}
              }),
            },
          },
        })
      }),
    }

    const mockService = {
      usage: vi.fn(async () => ({ state: 'unauthenticated' })),
    } as unknown as AntigravityAuthService

    registerAntigravityPetBalance(mockCtx as never, mockService)
    await expect(registeredProvider!.fetch({ provider: 'google-antigravity' })).rejects.toThrow(
      /Antigravity 未登录/,
    )
  })
})
