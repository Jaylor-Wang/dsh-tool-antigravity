/** Bounded, block-aligned replay metadata for Antigravity model turns. */

import type { ReplayEnvelope, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'

export const ANTIGRAVITY_REPLAY_VERSION = 1 as const
const MAX_SIGNATURE_LENGTH = 16 * 1024
const MAX_BLOCKS = 128

export type ReplayBlockKind = 'text' | 'reasoning' | 'tool-call'

export interface AntigravityReplayBlock {
  readonly kind: ReplayBlockKind
  readonly signature?: string
}

export interface AntigravityReplayResponse {
  readonly version: typeof ANTIGRAVITY_REPLAY_VERSION
  readonly provider: 'google-antigravity'
  readonly model: string
  readonly family: 'gemini' | 'claude' | 'gpt-oss' | 'unknown'
  readonly finish?: string
}

export interface AntigravityReplayState extends ReplayEnvelope {
  readonly response: AntigravityReplayResponse
  readonly blocks: readonly AntigravityReplayBlock[]
}

/** Keep only provider-issued signatures and bounded response facts. */
export function createReplayState(
  model: string,
  family: AntigravityReplayResponse['family'],
  finish: string | undefined,
  blocks: readonly AntigravityReplayBlock[],
): AntigravityReplayState {
  const boundedBlocks: AntigravityReplayBlock[] = blocks.slice(0, MAX_BLOCKS).map(block => {
    const signature = safeSignature(block.signature)
    return { kind: block.kind, ...(signature === undefined ? {} : { signature }) }
  })
  const boundedFinish = safeFinish(finish)
  return {
    response: {
      version: ANTIGRAVITY_REPLAY_VERSION,
      provider: 'google-antigravity',
      model: model.slice(0, 256),
      family,
      ...(boundedFinish === undefined ? {} : { finish: boundedFinish }),
    },
    blocks: boundedBlocks,
  }
}

/** Validate replay metadata before it can affect a later private request. */
export function compatibleReplayState(
  message: Message,
  provider: string,
  model: string,
  blockKinds?: readonly ReplayBlockKind[],
): AntigravityReplayState | undefined {
  if (provider !== 'google-antigravity' || message.role !== 'assistant') return undefined
  const provenance = isRecord(message.source) ? (message.source as Record<string, unknown>) : undefined
  if (provenance !== undefined && provenance.kind === 'model' && (provenance.provider !== provider || provenance.model !== model)) return undefined
  const value = isRecord(provenance?.replayState)
    ? provenance.replayState
    : isRecord((message as unknown as Record<string, unknown>).replayState)
      ? (message as unknown as Record<string, unknown>).replayState
      : undefined
  if (!isRecord(value) || !isRecord(value.response) || !Array.isArray(value.blocks)) return undefined
  const family = value.response.family
  if (value.response.version !== ANTIGRAVITY_REPLAY_VERSION
    || value.response.provider !== provider
    || value.response.model !== model
    || !isFamily(family)
    || value.blocks.length > MAX_BLOCKS) return undefined
  const blocks: AntigravityReplayBlock[] = []
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.kind !== 'string') continue
    const kind = item.kind as ReplayBlockKind
    const signature = typeof item.signature === 'string' && safeSignature(item.signature) !== undefined ? item.signature : undefined
    blocks.push({ kind, ...(signature === undefined ? {} : { signature }) })
  }
  if (blockKinds !== undefined
    && (blocks.length !== blockKinds.length || blocks.some((block, index) => block.kind !== blockKinds[index]))) return undefined
  const finish = value.response.finish === undefined ? undefined : safeFinish(value.response.finish)
  if (value.response.finish !== undefined && finish === undefined) return undefined
  return {
    response: {
      version: ANTIGRAVITY_REPLAY_VERSION,
      provider: 'google-antigravity',
      model,
      family,
      ...(finish === undefined ? {} : { finish }),
    },
    blocks,
  }
}

/** Return the block family without allowing a model alias to cross families. */
export function antigravityModelFamily(model: string): AntigravityReplayResponse['family'] {
  const value = model.toLowerCase()
  if (value.includes('gemini')) return 'gemini'
  if (value.includes('claude')) return 'claude'
  if (value.includes('gpt-oss')) return 'gpt-oss'
  return 'unknown'
}

const CORE_TOOLS = new Set([
  'read', 'write', 'edit', 'pwsh', 'bash', 'glob', 'grep',
  'read_page', 'web_search', 'web_fetch', 'ask_user_question',
])

/** Convert DSH schemas to the small function-declaration subset accepted privately. */
export function sanitizeToolSchemas(tools: readonly ToolSchema[] | undefined): readonly Record<string, unknown>[] {
  if (tools === undefined) return []
  const sorted = [...tools].sort((a, b) => {
    const aCore = CORE_TOOLS.has(a.name) ? 1 : 0
    const bCore = CORE_TOOLS.has(b.name) ? 1 : 0
    return bCore - aCore
  })
  return sorted.slice(0, 384).map(tool => ({
    name: boundedName(tool.name),
    description: boundedText(tool.description, 4096),
    parameters: sanitizeSchema(tool.parameters),
  }))
}

export function buildFunctionDeclarations(tools: readonly ToolSchema[] | undefined): readonly Record<string, unknown>[] {
  return sanitizeToolSchemas(tools).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

const ALLOWED_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function isNullBranch(branch: unknown): boolean {
  if (!isRecord(branch)) return false
  const t = typeof branch.type === 'string' ? branch.type.toLowerCase() : undefined
  return t === 'null' || (t === undefined && branch.const === null)
}

function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8 || !isRecord(value)) return { type: 'object', properties: {} }
  let source: Record<string, unknown> = value
  if (Array.isArray(source.allOf) && source.allOf.length > 0) {
    const mergedProps: Record<string, unknown> = isRecord(source.properties) ? { ...source.properties } : {}
    const mergedReq = new Set<string>(Array.isArray(source.required) ? source.required.filter((r): r is string => typeof r === 'string') : [])
    for (const branch of source.allOf.slice(0, 8)) {
      if (!isRecord(branch)) continue
      if (isRecord(branch.properties)) Object.assign(mergedProps, branch.properties)
      if (Array.isArray(branch.required)) {
        for (const req of branch.required) if (typeof req === 'string') mergedReq.add(req)
      }
    }
    source = { ...source, type: 'object', properties: mergedProps, ...(mergedReq.size > 0 ? { required: [...mergedReq] } : {}) }
  }
  const rawUnion = Array.isArray(source.anyOf) ? source.anyOf : Array.isArray(source.oneOf) ? source.oneOf : undefined
  if (rawUnion !== undefined && rawUnion.length > 0) {
    const nonNullBranches = rawUnion.filter(branch => !isNullBranch(branch))
    const hadNullBranch = nonNullBranches.length < rawUnion.length
    if (nonNullBranches.length === 1 && isRecord(nonNullBranches[0])) {
      const collapsed = sanitizeSchema({
        ...(typeof source.description === 'string' ? { description: source.description } : {}),
        ...nonNullBranches[0],
      }, depth + 1)
      if (hadNullBranch) collapsed.nullable = true
      return collapsed
    }
    const branches = (nonNullBranches.length > 0 ? nonNullBranches : rawUnion)
      .slice(0, 8)
      .map(item => sanitizeSchema(item, depth + 1))
    const output: Record<string, unknown> = { anyOf: branches }
    if (typeof source.description === 'string') output.description = boundedText(source.description, 1024)
    if (hadNullBranch || source.nullable === true) output.nullable = true
    return output
  }
  let explicitType: string | undefined
  let nullable = source.nullable === true
  if (typeof source.type === 'string' && ALLOWED_SCHEMA_TYPES.has(source.type.toLowerCase())) {
    explicitType = source.type.toLowerCase()
  } else if (Array.isArray(source.type)) {
    const validTypes = [...new Set(
      source.type
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.toLowerCase())
        .filter(item => ALLOWED_SCHEMA_TYPES.has(item)),
    )]
    const nonNull = validTypes.filter(item => item !== 'null')
    if (validTypes.includes('null') && nonNull.length > 0) nullable = true
    explicitType = nonNull[0] ?? validTypes[0]
  }
  let enumValues: string[] | undefined
  const hints: string[] = []
  if (typeof source.const === 'string' && source.const.length > 0 && !hasControl(source.const)) {
    enumValues = [source.const.slice(0, 256)]
    explicitType ??= 'string'
  } else if (typeof source.const === 'number' || typeof source.const === 'boolean') {
    hints.push(`Must be ${String(source.const)}`)
    explicitType ??= typeof source.const
  } else if (Array.isArray(source.enum)) {
    const rawEnum = source.enum.slice(0, 128).filter(item => ['string', 'number', 'boolean'].includes(typeof item) && item !== '')
    if (rawEnum.length > 0) {
      if (rawEnum.every((item): item is string => typeof item === 'string' && !hasControl(item))) {
        enumValues = rawEnum.map(item => item.slice(0, 256))
        explicitType ??= 'string'
      } else {
        hints.push(`Allowed values: ${rawEnum.map(item => JSON.stringify(item)).join(', ')}`)
      }
    }
  }
  const type = explicitType ?? (source.items !== undefined ? 'array' : 'object')
  const output: Record<string, unknown> = { type }
  const baseDesc = typeof source.description === 'string' ? boundedText(source.description, 1024) : ''
  const fullDesc = hints.length > 0 ? (baseDesc ? `${baseDesc} (${hints.join('; ')})` : hints.join('; ')) : baseDesc
  if (fullDesc.length > 0) output.description = boundedText(fullDesc, 1024)
  if (nullable && type !== 'null') output.nullable = true
  if (enumValues !== undefined && enumValues.length > 0) output.enum = enumValues
  if (type === 'object') {
    const properties: Record<string, unknown> = {}
    if (isRecord(source.properties)) {
      for (const [key, item] of Object.entries(source.properties).slice(0, 128)) {
        if (!hasControl(key) && key.length > 0) properties[key.slice(0, 128)] = sanitizeSchema(item, depth + 1)
      }
    }
    output.properties = properties
    if (Array.isArray(source.required)) {
      const validRequired = source.required
        .filter((item): item is string => typeof item === 'string' && Object.prototype.hasOwnProperty.call(properties, item))
        .slice(0, 128)
      if (validRequired.length > 0) output.required = validRequired
    }
  } else if (type === 'array') {
    output.items = source.items !== undefined ? sanitizeSchema(source.items, depth + 1) : { type: 'string' }
  }
  return output
}

function safeFinish(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined
  const normalized = value.toUpperCase()
  return ['STOP', 'MAX_TOKENS', 'LENGTH', 'TOOL_CALLS', 'FUNCTION_CALL', 'SAFETY', 'BLOCKLIST', 'ERROR'].includes(normalized) ? normalized : undefined
}

function safeSignature(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SIGNATURE_LENGTH) return undefined
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return undefined
  }
  return value
}

function boundedName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && !hasControl(value) ? value.slice(0, 128) : 'unnamed_tool'
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' && !hasControl(value) ? value.slice(0, limit) : ''
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function isFamily(value: unknown): value is AntigravityReplayResponse['family'] {
  return value === 'gemini' || value === 'claude' || value === 'gpt-oss' || value === 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
