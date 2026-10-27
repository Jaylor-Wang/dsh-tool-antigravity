/**
 * Tests for LLM adapter hardening:
 * 1. Tool schema prioritization (CORE_TOOLS first) and expanded cap (384).
 * 2. Empty string enum filter in tool schemas.
 * 3. Error reporting via functionResponse.response.error when isError is true.
 * 4. Deduplication of text blocks in tool role messages.
 * 5. Image inline budget enforcement with image offloading negotiation.
 */

import { describe, expect, it } from 'vitest'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  AntigravityAdapter,
  buildAntigravityGeneratePayload,
} from '../src/llm-adapter.ts'
import { sanitizeToolSchemas } from '../src/replay.ts'
import type { HostCredential } from '../src/credential-coordinator.ts'

const MOCK_CREDENTIAL: HostCredential = {
  accessToken: 'ya29.mock-token',
  refreshToken: '1//mock-refresh-token',
  expiresAt: Date.now() + 3_600_000,
  projectId: 'mock-project',
}

describe('LLM adapter hardening: Tool schemas', () => {
  it('prioritizes CORE_TOOLS and expands tool capacity to 384', () => {
    const customTools: ToolSchema[] = Array.from({ length: 400 }, (_, i) => ({
      name: `custom_tool_${i}`,
      description: `Custom tool number ${i}`,
      parameters: { type: 'object', properties: {} },
    }))

    // Insert core tools at the end of the array
    customTools.push(
      { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: {} } },
      { name: 'pwsh', description: 'Execute PowerShell', parameters: { type: 'object', properties: {} } },
    )

    const sanitized = sanitizeToolSchemas(customTools)
    expect(sanitized.length).toBe(384)

    // Core tools should be sorted to the very front
    const firstThreeNames = sanitized.slice(0, 3).map(t => t.name)
    expect(firstThreeNames).toContain('read')
    expect(firstThreeNames).toContain('write')
    expect(firstThreeNames).toContain('pwsh')
  })

  it('filters empty strings from enum definitions', () => {
    const tools: ToolSchema[] = [
      {
        name: 'test_tool',
        description: 'Tool with empty string in enum',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['auto', '', 'manual'],
            },
            emptyOnly: {
              type: 'string',
              enum: [''],
            },
          },
        },
      },
    ]

    const sanitized = sanitizeToolSchemas(tools)
    const props = (sanitized[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
    expect(props.mode?.enum).toEqual(['auto', 'manual'])
    expect(props.emptyOnly?.enum).toBeUndefined()
  })

  it('normalizes nullable type arrays, oneOf/const unions, and undefined required fields for Gemini wire', () => {
    const tools: ToolSchema[] = [
      {
        name: 'knowledge_tool',
        description: 'Knowledge tool with nullable arrays and oneOf const unions',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              oneOf: [
                { const: 'knowledge.list', description: 'List items' },
                { const: 'knowledge.save', description: 'Save item' },
              ],
            },
            planId: {
              type: ['string', 'null'],
              description: 'Optional nullable plan id',
            },
            workingDirectory: {
              oneOf: [{ type: 'null', const: null }, { type: 'string' }],
              description: 'Nullable working directory union',
            },
          },
          required: ['action', 'nonexistentField'],
        },
      },
    ]

    const payload = buildAntigravityGeneratePayload({
      provider: 'google-antigravity',
      model: 'antigravity-gemini-3.8-flash',
      messages: [{ id: 'm1' as never, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      tools,
    }, MOCK_CREDENTIAL)

    const wire = JSON.stringify((payload.request as { tools: unknown }).tools)
    expect(wire).not.toContain('"oneOf"')
    expect(wire).not.toContain('"allOf"')
    expect(wire).not.toContain('nonexistentField')
    expect(wire).not.toMatch(/"type"\s*:\s*\[/)
    expect(wire).toContain('"anyOf"')
    expect(wire).toContain('"nullable":true')
  })
})

describe('LLM adapter hardening: Tool responses and deduplication', () => {
  it('maps tool result with isError=true to response.error instead of response.content', () => {
    const messages: Message[] = [
      {
        id: 'msg-1' as never,
        role: 'user',
        content: [{ type: 'text', text: 'run command' }],
        source: { kind: 'user' },
      },
      {
        id: 'msg-2' as never,
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_1' as never, name: 'pwsh', arguments: '{"command":"dir"}' }],
        source: { kind: 'model', provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' },
      },
      {
        id: 'msg-3' as never,
        role: 'tool',
        toolCallId: 'call_1',
        isError: true,
        content: [{ type: 'text', text: 'Command failed with exit code 1' }],
        source: { kind: 'tool', toolCallId: 'call_1' },
      } as unknown as Message,
    ]

    const payload = buildAntigravityGeneratePayload({
      provider: 'google-antigravity',
      model: 'antigravity-gemini-3.8-flash',
      messages,
    }, MOCK_CREDENTIAL)

    const request = payload.request as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
    const toolMsg = request.contents.find(c => c.parts.some(p => p.functionResponse !== undefined))
    expect(toolMsg).toBeDefined()

    const part = toolMsg?.parts.find(p => p.functionResponse !== undefined)
    const fnResp = part?.functionResponse as { name: string; response: Record<string, unknown> }
    expect(fnResp.name).toBe('pwsh')
    expect(fnResp.response.error).toBe('Command failed with exit code 1')
    expect(fnResp.response.content).toBeUndefined()
  })

  it('does not duplicate text block when tool response was emitted for message.role=tool', () => {
    const messages: Message[] = [
      {
        id: 'msg-1' as never,
        role: 'user',
        content: [{ type: 'text', text: 'do something' }],
        source: { kind: 'user' },
      },
      {
        id: 'msg-2' as never,
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_1' as never, name: 'read', arguments: '{"file":"a.txt"}' }],
        source: { kind: 'model', provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' },
      },
      {
        id: 'msg-3' as never,
        role: 'tool',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'file content' }],
        source: { kind: 'tool', toolCallId: 'call_1' },
      } as unknown as Message,
    ]

    const payload = buildAntigravityGeneratePayload({
      provider: 'google-antigravity',
      model: 'antigravity-gemini-3.8-flash',
      messages,
    }, MOCK_CREDENTIAL)

    const request = payload.request as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
    const toolContent = request.contents[request.contents.length - 1]
    expect(toolContent).toBeDefined()
    // Should have only 1 part (functionResponse), text should NOT be duplicated as an extra text part
    expect(toolContent?.parts.length).toBe(1)
    expect(toolContent?.parts[0]?.functionResponse).toBeDefined()
  })
})

describe('LLM adapter hardening: Offloaded images projection', () => {
  it('projects offloaded images to descriptive placeholder text', () => {
    const messages: Message[] = [
      {
        id: 'msg-1' as never,
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'att-1',
              name: 'screenshot.png',
              mediaType: 'image/png',
              width: 800,
              height: 600,
              bytes: 1024,
            },
            offloaded: true,
          } as never,
          { type: 'text', text: 'What is in this picture?' },
        ],
        source: { kind: 'user' },
      },
    ]

    const payload = buildAntigravityGeneratePayload({
      provider: 'google-antigravity',
      model: 'antigravity-gemini-3.8-flash',
      messages,
    }, MOCK_CREDENTIAL)

    const request = payload.request as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
    const userMsg = request.contents[0]
    expect(userMsg).toBeDefined()

    // The offloaded image should become a text block containing "image omitted"
    const textPart = userMsg?.parts.find(p => typeof p.text === 'string' && p.text.includes('image omitted'))
    expect(textPart).toBeDefined()
    expect((textPart?.text as string)).toContain('screenshot.png')
  })
})
