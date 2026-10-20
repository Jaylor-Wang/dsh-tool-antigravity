import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  getAntigravityOpencodeModelIds,
  getQuotaGroupForModel,
  resolveModelWithTier,
} from '@cortexkit/antigravity-auth-core'
import { ANTIGRAVITY_PROVIDER, buildAntigravityGeneratePayload } from '../src/llm-adapter.ts'
import type { HostCredential } from '../src/credential-coordinator.ts'
import { normalizeQuotaResponse } from '../src/quota.ts'

const credential: HostCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
  projectId: 'project-id',
}

const message = (text: string): Message => ({
  id: 'message-id' as never,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

type CapturedPayload = {
  model: string
  request: { generationConfig?: { thinkingConfig?: Record<string, unknown> } }
}

function payloadFor(model: string, effort?: 'low' | 'medium' | 'high'): CapturedPayload {
  return buildAntigravityGeneratePayload({
    provider: ANTIGRAVITY_PROVIDER,
    model,
    messages: [message('hello')],
    ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
  }, credential) as unknown as CapturedPayload
}

describe('new Antigravity models', () => {
  it('publishes Gemini 4 Argon and the Claude 5.5 thinking tiers', () => {
    const ids = getAntigravityOpencodeModelIds()
    expect(ids).toContain('antigravity-gemini-4-argon')
    expect(ids).toContain('antigravity-claude-sonnet-5-5-thinking')
    expect(ids).toContain('antigravity-claude-opus-5-5-thinking')
    expect(getQuotaGroupForModel('gemini-4-argon-high')).toBe('gemini')
    expect(getQuotaGroupForModel('claude-sonnet-5-5-medium')).toBe('non-gemini')
  })

  it('routes Gemini 4 Argon to the tiered wire id with a thinking level', () => {
    expect(resolveModelWithTier('antigravity-gemini-4-argon').actualModel).toBe('gemini-4-argon-medium')
    expect(resolveModelWithTier('antigravity-gemini-4-argon-high').actualModel).toBe('gemini-4-argon-high')

    const defaulted = payloadFor('antigravity-gemini-4-argon')
    expect(defaulted.model).toBe('gemini-4-argon-medium')
    expect(defaulted.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'medium',
    })

    const high = payloadFor('antigravity-gemini-4-argon', 'high')
    expect(high.model).toBe('gemini-4-argon-high')
    expect(high.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'high',
    })
  })

  it('routes Claude 5.5 to the numbered wire id with a tier thinking budget', () => {
    const sonnet = payloadFor('antigravity-claude-sonnet-5-5-thinking')
    expect(sonnet.model).toBe('claude-sonnet-5-5-medium')
    expect(sonnet.request.generationConfig?.thinkingConfig).toMatchObject({
      include_thoughts: true,
      thinking_budget: 16384,
    })

    const opus = payloadFor('antigravity-claude-opus-5-5-thinking', 'low')
    expect(opus.model).toBe('claude-opus-5-5-low')
    expect(opus.request.generationConfig?.thinkingConfig).toMatchObject({
      include_thoughts: true,
      thinking_budget: 8192,
    })
  })

  it('surfaces the Argon-only weekly quota as its own group after the Gemini groups', () => {
    const reset = '2030-01-01T00:00:00.000Z'
    const status = normalizeQuotaResponse({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.87, resetTime: reset }],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: reset }],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [{ bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.39, resetTime: reset }],
        },
      ],
    })

    expect(status.state).toBe('available')
    expect(status.groups?.map(group => group.group)).toEqual(['gemini', 'non-gemini', 'argon'])
    expect(status.groups?.at(-1)?.windows).toEqual([
      { window: 'weekly', remainingFraction: 0.39, resetTime: reset },
    ])
  })
})
