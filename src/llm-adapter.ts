/** Public DSH LLM adapter for the single Antigravity provider route. */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AgyRequestSessionStore,
  CLAUDE_DESCRIPTION_PROMPT,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  SKIP_THOUGHT_SIGNATURE,
  applyAgyNativeGenerationConfig,
  applyClaudeTransforms,
  applyGeminiTransforms,
  buildAgyAgentRequestMetadata,
  fnv1a64Signed,
  getAgyNativeModel,
  getPublicModelDefinitions,
  getResolverAliasMap,
  isGeminiArgonModel,
  isRetiredAgyModel,
  orderAgyRequestPayloadInPlace,
  resolveModelWithTier,
  toGeminiSchema,
} from '@cortexkit/antigravity-auth-core'
import * as dshLlm from '@deepseek-ai/dsh-llm'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ReplayEnvelope,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { CredentialCoordinator, HostCredential } from './credential-coordinator.ts'
import {
  DEFAULT_PRIVATE_FRAME_BYTES,
  DEFAULT_PRIVATE_REQUEST_BYTES,
  DEFAULT_PRIVATE_IDLE_TIMEOUT_MS,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS,
  DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS,
  PrivateTransportError,
  createPrivateTransport,
  iteratePrivateSse,
  privateStatusError,
  readPrivateText,
  type PrivateTransport,
} from './private-transport.ts'
import {
  antigravityModelFamily,
  buildFunctionDeclarations,
  compatibleReplayState,
  createReplayState,
  type AntigravityReplayBlock,
} from './replay.ts'
import { ANTIGRAVITY_WIRE_ORIGIN } from './wire-identity.ts'
import { classifyPrivateFailure, type PrivateFailureKind } from './private-failure.ts'
import type { AntigravityModelCatalogState, AntigravityModelCatalogView } from './model-catalog.ts'

export const ANTIGRAVITY_PROVIDER = 'google-antigravity' as const
const ANTIGRAVITY_REQUEST_IMAGE_MAX_PIXELS = 4 * 1024 * 1024
const ANTIGRAVITY_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
/** Inline image budget for the private route: base64 bytes the transport tolerates for images alone. */
const ANTIGRAVITY_INLINE_IMAGE_BYTES = 12 * 1024 * 1024
export const ANTIGRAVITY_STREAM_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:streamGenerateContent?alt=sse` as const
export const ANTIGRAVITY_GENERATE_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:generateContent` as const
export const ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:fetchAvailableModels` as const
export const ANTIGRAVITY_LLM_ROUTE = ANTIGRAVITY_PROVIDER
const MODEL_CATALOG_TTL_MS = 30_000
const MAX_MODEL_CATALOG_BYTES = 256 * 1024
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024
const MAX_PROVIDER_ERROR_FRAME_BYTES = 16 * 1024
const MAX_PROVIDER_ERROR_JSON_DEPTH = 8
const MAX_PROVIDER_PARTS = 4096

export interface AntigravityAuthCredentialSource {
  credential(signal?: AbortSignal, options?: { readonly forceRefresh?: boolean; readonly family?: string }): Promise<HostCredential | undefined>
  rotateOnFailure?(failure: {
    readonly reason?: string | undefined
    readonly message?: string | undefined
    readonly status?: number | undefined
    readonly retryAfterMs?: number | null
    readonly family?: string | undefined
  }): Promise<('rotate' | 'stay' | 'relogin' | 'exhausted')>
  accountCount?(): Promise<number>
}

export interface AntigravityAdapterOptions {
  readonly auth: Pick<CredentialCoordinator, 'credential'> | AntigravityAuthCredentialSource
  /** Whole-transport injection is the only private-request test seam. */
  readonly transport?: PrivateTransport
  readonly responseHeaderTimeoutMs?: number
  readonly idleTimeoutMs?: number
  readonly totalTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxFrameBytes?: number
  readonly attachments?: Pick<AttachmentStore, 'readImage'> & {
    readImageRequest?(ref: ImageAttachmentRef, bounds: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
  }
  readonly fs?: Pick<FileSystem, 'processPathFromHostPath'>
  /** Optional path to persist the last live server catalog for offline/error fallback across restarts. */
  readonly catalogCachePath?: string
}

interface DynamicWireSpec {
  readonly maxOutputTokens?: number
  readonly modelEnum?: string
  readonly thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH'
  readonly supportsThinking?: boolean
}

interface DynamicCatalogContext {
  readonly definitions: Readonly<Record<string, ReturnType<typeof getPublicModelDefinitions>[string]>>
  readonly wireSpecs: Readonly<Record<string, DynamicWireSpec>>
  readonly modelBaseByPublicId: Readonly<Record<string, string>>
}

interface CachedLiveCatalog {
  readonly checkedAt: string
  readonly availableIds: readonly string[]
  readonly dynamicDefinitions: Readonly<Record<string, ReturnType<typeof getPublicModelDefinitions>[string]>>
  readonly dynamicWireSpecs: Readonly<Record<string, DynamicWireSpec>>
  readonly modelBaseByPublicId: Readonly<Record<string, string>>
  readonly catalogEntries: readonly AntigravityModelCatalogView['models'][number][]
}

interface ProviderPartText {
  readonly kind: 'text' | 'reasoning'
  readonly text: string
  readonly signature?: string
}

interface ProviderPartTool {
  readonly kind: 'tool-call'
  readonly name?: string
  readonly id?: string
  readonly arguments: string
  readonly signature?: string
}

type ProviderPart = ProviderPartText | ProviderPartTool

interface ProviderEvent {
  readonly parts: readonly ProviderPart[]
  readonly usage?: TokenUsage
  readonly finish?: string
  readonly error?: { readonly status?: number; readonly code?: string; readonly contextWindowExceeded?: boolean }
}

export interface AntigravityRequestMetadata {
  readonly requestId: string
  readonly sessionId: string
  readonly labels: Record<string, string>
  readonly lastStepIndex: number
}

/** Adapter that owns exactly one provider route and no fallback route. */
export class AntigravityAdapter extends LlmAdapter {
  private readonly transport: PrivateTransport
  private readonly sessions = new AgyRequestSessionStore('dsh-antigravity-auth')
  private readonly options: Required<Pick<AntigravityAdapterOptions, 'idleTimeoutMs' | 'totalTimeoutMs' | 'maxResponseBytes' | 'maxFrameBytes'>> & {
    readonly responseHeaderTimeoutMs: number
  }
  private readonly definitions = buildPublicModelDefinitions()
  private catalogProjectId: string | undefined
  private catalogAccountKey: string | undefined
  private catalogExpiresAt = 0
  private catalogLive: ParsedLiveCatalog | undefined
  private catalogFailureCode: string | undefined
  private lastAttemptedCacheKey: string | undefined
  private readonly staleCacheByKey = new Map<string, CachedLiveCatalog>()
  private readonly dynamicDefinitions: Record<string, ReturnType<typeof getPublicModelDefinitions>[string]> = {}
  private readonly dynamicWireSpecs: Record<string, DynamicWireSpec> = {}
  private readonly dynamicBaseByPublicId: Record<string, string> = {}
  private catalogView: AntigravityModelCatalogView

  constructor(private readonly adapterOptions: AntigravityAdapterOptions) {
    super()
    this.transport = adapterOptions.transport ?? createPrivateTransport(
      adapterOptions.responseHeaderTimeoutMs === undefined ? {} : { responseHeaderTimeoutMs: adapterOptions.responseHeaderTimeoutMs },
    )
    this.options = {
      responseHeaderTimeoutMs: boundedTimeout(adapterOptions.responseHeaderTimeoutMs, DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS),
      idleTimeoutMs: boundedTimeout(adapterOptions.idleTimeoutMs, DEFAULT_PRIVATE_IDLE_TIMEOUT_MS),
      totalTimeoutMs: boundedTimeout(adapterOptions.totalTimeoutMs, DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS),
      maxResponseBytes: boundedLimit(adapterOptions.maxResponseBytes, DEFAULT_PRIVATE_RESPONSE_BYTES),
      maxFrameBytes: boundedLimit(adapterOptions.maxFrameBytes, DEFAULT_PRIVATE_FRAME_BYTES),
    }
    this.loadPersistedCatalogCache()
    this.catalogView = createCatalogView(this.definitions, 'snapshot')
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== ANTIGRAVITY_PROVIDER) throw new LlmError('Unknown Antigravity provider route', 'NO_ADAPTER')
    return { id: ANTIGRAVITY_PROVIDER, name: 'Google Antigravity' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    // Pre-delta network failures and 429 account rotations are handled internally
    // before any chunk is yielded. Host-level retry (dsh-llm-retry) recovers
    // mid-stream timeouts, connection drops, and truncated SSE streams after
    // reasoning or text chunks have already been emitted.
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT', 'UPSTREAM'],
      backoff: { initialDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0.1 },
    }, 'google-antigravity')
  }

  /** Forget account-bound availability when Gate 0 or the credential is replaced. */
  invalidateModelCatalog(clearPersisted = false): void {
    this.catalogProjectId = undefined
    this.catalogAccountKey = undefined
    this.catalogExpiresAt = 0
    this.catalogLive = undefined
    this.catalogFailureCode = undefined
    this.lastAttemptedCacheKey = undefined
    if (clearPersisted) {
      this.staleCacheByKey.clear()
      for (const key of Object.keys(this.dynamicDefinitions)) delete this.dynamicDefinitions[key]
      for (const key of Object.keys(this.dynamicWireSpecs)) delete this.dynamicWireSpecs[key]
      for (const key of Object.keys(this.dynamicBaseByPublicId)) delete this.dynamicBaseByPublicId[key]
      this.clearPersistedCatalogCache()
    }
    this.catalogView = createCatalogView(this.definitions, 'snapshot')
  }

  /** Return the pinned catalog without performing credential or network work. */
  catalogSnapshot(): AntigravityModelCatalogView {
    return cloneCatalogView(createCatalogView(this.definitions, 'snapshot'))
  }

  /** Refresh the advisory catalog and collapse failures into browser-safe state. */
  async modelCatalog(signal?: AbortSignal, forceRefresh = false): Promise<AntigravityModelCatalogView> {
    try {
      const live = await this.readLiveCatalog(signal, forceRefresh)
      const checkedAt = new Date().toISOString()
      this.catalogView = createLiveCatalogView(this.definitions, live, checkedAt)
    } catch (error) {
      const state = error instanceof LlmError && error.code === 'PROTOCOL_DRIFT' ? 'protocol-drift' : 'refresh-failed'
      this.catalogView = this.buildFallbackCatalogView(state, this.lastAttemptedCacheKey)
    }
    return cloneCatalogView(this.catalogView)
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    const snapshot = this.pinnedTextModelInfos()
    let live: ParsedLiveCatalog
    try {
      live = await this.readLiveCatalog(signal)
      this.catalogView = createLiveCatalogView(this.definitions, live, new Date().toISOString())
    } catch (error) {
      const state = error instanceof LlmError && error.code === 'PROTOCOL_DRIFT' ? 'protocol-drift' : 'refresh-failed'
      this.catalogView = this.buildFallbackCatalogView(state, this.lastAttemptedCacheKey)
      if (!canFallBackToPinnedTextSnapshot(error)) throw error
      const cached = this.resolveFallbackCache(this.lastAttemptedCacheKey)
      if (cached !== undefined) return this.cachedTextModelInfos(cached)
      // DSH drops the whole provider group when a transient discovery failure escapes.
      // When no live cache exists yet, fall back to the known snapshot list safely.
      return snapshot
    }
    return liveTextModelInfos(this.definitions, live)
  }

  private pinnedTextModelInfos(): readonly LlmModelInfo[] {
    return Object.values(this.definitions)
      .filter(definition => !definition.modalities.output.includes('image'))
      .map(toLlmModelInfo)
  }

  private cachedTextModelInfos(cached: CachedLiveCatalog): readonly LlmModelInfo[] {
    const merged: Record<string, ReturnType<typeof getPublicModelDefinitions>[string]> = {
      ...this.definitions,
      ...cached.dynamicDefinitions,
    }
    const available = new Set(cached.availableIds)
    return Object.values(merged)
      .filter(definition => !definition.modalities.output.includes('image') && available.has(definition.id))
      .map(toLlmModelInfo)
  }

  private allKnownDefinitions(): Readonly<Record<string, ReturnType<typeof getPublicModelDefinitions>[string]>> {
    return {
      ...this.dynamicDefinitions,
      ...this.definitions,
    }
  }

  private dynamicCatalogContext(): DynamicCatalogContext {
    return {
      definitions: this.dynamicDefinitions,
      wireSpecs: this.dynamicWireSpecs,
      modelBaseByPublicId: this.dynamicBaseByPublicId,
    }
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider)
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 256) {
      throw new LlmError('The Antigravity model id is invalid', 'INVALID_MODEL')
    }
    const definition = this.allKnownDefinitions()[model]
    if (definition === undefined || definition.modalities.output.includes('image')) {
      throw new LlmError('The Antigravity model is not in the audited text model snapshot', 'INVALID_MODEL')
    }
    const reasoning = getModelReasoningEfforts(model, definition)
    return {
      provider: ANTIGRAVITY_PROVIDER,
      id: definition.id,
      name: cleanModelDisplayName(definition.name),
      inputModalities: definition.modalities.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image'),
      context: { contextWindow: definition.limit.context },
      defaultMaxTokens: definition.limit.output,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== ANTIGRAVITY_PROVIDER) {
      throw new LlmError('The Antigravity adapter received an unknown provider route', 'NO_ADAPTER')
    }
    const signal = options.signal
    const requestedDefinition = this.allKnownDefinitions()[options.model]
    if (requestedDefinition === undefined || requestedDefinition.modalities.output.includes('image')) throw new LlmError('The Antigravity model is not in the audited text model snapshot', 'INVALID_MODEL')
    if (isAborted(signal)) {
      yield finishChunk('aborted', 'CANCELLED')
      return
    }
    const family = antigravityModelFamily(options.model)
    const hasEmitted = { value: false }
    let replayed = false
    let networkRetryCount = 0
    const MAX_NETWORK_RETRIES = 3
    let rotationAttempts = 0
    const maxRotations = await this.rotationBudget()
    for (;;) {
      const credential = await this.readCredential(signal, replayed, family)
      if (credential === undefined) {
        throw new LlmError('Antigravity login is required before model use', 'AUTH')
      }
      const sessionKey = requestSessionKey(options)
      const requestScope = this.sessions.beginRequest(sessionKey)
      let payload: Record<string, unknown> & { sentImageBytes?: Map<string, number> }
      try {
        payload = await buildAntigravityGeneratePayloadForAdapter(options, credential, requestScope.session, requestScope.timestamp, this.adapterOptions.attachments, this.adapterOptions.fs, this.dynamicCatalogContext())
      } catch (error) {
        if (error instanceof LlmError) throw error
        throw new LlmError('The Antigravity image input could not be admitted safely', 'UNSUPPORTED_MODALITY')
      }
      const sentImageBytes = payload.sentImageBytes
      delete payload.sentImageBytes
      const serialized = JSON.stringify(payload)
      /** Images alone exceed the private route's inline image budget: negotiate a logged offload. */
      const imageOffload = antigravityImageOffloadCount(options.messages, sentImageBytes)
      if (imageOffload > 0) {
        throw new LlmError(
          `The Antigravity image payload exceeds the route image budget; offload ${String(imageOffload)} oldest retained image occurrence(s)`,
          IMAGE_OFFLOAD_REQUIRED_CODE,
          { offloadImages: imageOffload } as Record<string, unknown>,
        )
      }
      /** Whole request exceeds the transport ceiling for reasons other than images: fail without blaming them. */
      const requestBudget = boundedRequestBytes(this.adapterOptions.maxRequestBytes)
      if (new TextEncoder().encode(serialized).byteLength > requestBudget) {
        throw new LlmError('The Antigravity request exceeds the private transport byte limit', 'REQUEST_LIMIT')
      }
      let response: Response
      try {
        response = await this.transport.request({
          url: ANTIGRAVITY_STREAM_ENDPOINT,
          accessToken: credential.accessToken,
          body: serialized,
          ...(signal === undefined ? {} : { signal }),
          responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs,
        })
      } catch (error) {
        if (networkRetryCount < MAX_NETWORK_RETRIES && !hasEmitted.value && !isAborted(signal) && isRetryableNetworkError(error)) {
          networkRetryCount += 1
          const backoffMs = Math.min(1000 * Math.pow(2, networkRetryCount - 1), 4000)
          await waitRetryBackoff(backoffMs, signal)
          continue
        }
        throw toLlmError(error)
      }
      const statusError = privateStatusError(response.status)
      if (statusError !== undefined) {
        if (statusError.code === 'authentication' && !replayed && !hasEmitted.value && !isAborted(signal)) {
          await cancelResponse(response)
          replayed = true
          continue
        }
        if (statusError.code === 'rate-limited' && !hasEmitted.value && !isAborted(signal) && rotationAttempts < maxRotations) {
          await cancelResponse(response)
          const rotated = await this.tryRotate(family, response.status, 'rate-limited')
          if (rotated) {
            rotationAttempts += 1
            continue
          }
        }
        if ((response.status === 502 || response.status === 503 || response.status === 504) && networkRetryCount < MAX_NETWORK_RETRIES && !hasEmitted.value && !isAborted(signal)) {
          await cancelResponse(response)
          networkRetryCount += 1
          const backoffMs = Math.min(1000 * Math.pow(2, networkRetryCount - 1), 4000)
          await waitRetryBackoff(backoffMs, signal)
          continue
        }
        if (response.status === 400 && await responseReportsContextWindowExceeded(response, {
          ...(signal === undefined ? {} : { signal }),
          idleTimeoutMs: this.options.idleTimeoutMs,
          totalTimeoutMs: this.options.totalTimeoutMs,
          maxResponseBytes: this.options.maxResponseBytes,
          maxFrameBytes: this.options.maxFrameBytes,
        })) {
          throw contextWindowExceededError(response.status)
        }
        await cancelResponse(response)
        throw toLlmError(statusError)
      }
      try {
        yield* this.streamResponse(response, options, hasEmitted)
        this.sessions.completeExecution(sessionKey)
        return
      } catch (error) {
        const privateError = error instanceof PrivateTransportError ? error : undefined
        if (privateError?.code === 'authentication' && !replayed && !hasEmitted.value && !isAborted(signal)) {
          replayed = true
          continue
        }
        if (privateError?.code === 'rate-limited' && !hasEmitted.value && !isAborted(signal) && rotationAttempts < maxRotations) {
          const rotated = await this.tryRotate(family, privateError.status ?? 429, 'rate-limited')
          if (rotated) {
            rotationAttempts += 1
            continue
          }
        }
        if (networkRetryCount < MAX_NETWORK_RETRIES && !hasEmitted.value && !isAborted(signal) && isRetryableNetworkError(error)) {
          networkRetryCount += 1
          const backoffMs = Math.min(1000 * Math.pow(2, networkRetryCount - 1), 4000)
          await waitRetryBackoff(backoffMs, signal)
          continue
        }
        throw toLlmError(error)
      }
    }
  }

  private async *streamResponse(
    response: Response,
    options: GenerateOptions,
    hasEmitted: { value: boolean },
  ): AsyncGenerator<StreamChunk> {
    const states: BlockState[] = []
    let current: BlockState | undefined
    let usage: TokenUsage | undefined
    let finish: string | undefined
    let eventError: ProviderEvent['error']
    for await (const sse of iteratePrivateSse(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      idleTimeoutMs: this.options.idleTimeoutMs,
      totalTimeoutMs: this.options.totalTimeoutMs,
      maxBytes: this.options.maxResponseBytes,
      maxFrameBytes: this.options.maxFrameBytes,
    })) {
      if (sse.data.trim() === '[DONE]') continue
      let event: ProviderEvent
      try {
        event = parseProviderEvent(sse.data)
      } catch (error) {
        if (hasEmitted.value && error instanceof PrivateTransportError && error.code === 'invalid-response') {
          throw new PrivateTransportError('offline', 'The private SSE response stream ended with a truncated frame')
        }
        throw error
      }
      if (event.error !== undefined) {
        eventError = event.error
        if (event.error.status === 401 || isAuthenticationCode(event.error.code)) throw new PrivateTransportError('authentication', 'The private endpoint requires authentication', { status: event.error.status ?? 401 })
        break
      }
      if (event.usage !== undefined) usage = event.usage
      if (event.finish !== undefined) finish = event.finish
      for (const part of event.parts) {
        if (current === undefined || !sameBlock(current, part)) {
          if (current !== undefined) {
            yield endBlock(current)
          }
          current = beginBlock(states, part)
          yield { type: 'block-start', index: current.index, blockType: current.kind }
        }
        if (part.kind === 'tool-call') {
          if (part.name !== undefined) current.name = assembleFunctionName(current.name, part.name)
          current.text += part.arguments
          hasEmitted.value ||= part.arguments.length > 0 || part.name !== undefined
          yield {
            type: 'tool-call-delta',
            index: current.index,
            id: current.id,
            ...(part.name === undefined ? {} : { name: part.name }),
            argumentsDelta: part.arguments,
          }
          if (part.signature !== undefined) current.signature = part.signature
        } else if (part.kind === 'reasoning') {
          current.text += part.text
          hasEmitted.value ||= part.text.length > 0
          if (part.text.length > 0) yield { type: 'reasoning-delta', index: current.index, text: part.text }
        } else {
          current.text += part.text
          hasEmitted.value ||= part.text.length > 0
          if (part.text.length > 0) yield { type: 'text-delta', index: current.index, text: part.text }
        }
      }
    }
    if (current !== undefined) yield endBlock(current)
    if (usage !== undefined) yield { type: 'usage', usage }
    if (eventError !== undefined) {
      yield finishChunk(
        'error',
        eventError.contextWindowExceeded === true ? CONTEXT_WINDOW_EXCEEDED_CODE : safeProviderErrorCode(eventError.code),
        safeProviderStatus(eventError.status),
      )
      return
    }
    if (isAborted(options.signal)) {
      yield finishChunk('aborted', 'CANCELLED')
      return
    }
    if (states.length === 0) {
      yield finishChunk('error', 'EMPTY_RESPONSE')
      return
    }
    const replayBlocks: AntigravityReplayBlock[] = states.map(state => ({
      kind: state.kind,
      ...(state.signature === undefined ? {} : { signature: state.signature }),
    }))
    const replayState = createReplayState(options.model, antigravityModelFamily(options.model), finish, replayBlocks)
    yield finishChunk(mapFinishReason(finish), finish ?? 'STOP', undefined, replayState)
  }

  private async readLiveCatalog(
    signal: AbortSignal | undefined,
    bypassCache = false,
    forceCredentialRefresh = false,
  ): Promise<ParsedLiveCatalog> {
    const credential = await this.readCredential(signal, forceCredentialRefresh)
    if (credential === undefined) throw new LlmError('Antigravity login is required before model discovery', 'AUTH')
    const accountKey = accountCacheKey(credential)
    this.lastAttemptedCacheKey = accountKey
    if (!bypassCache && this.catalogAccountKey === accountKey && this.catalogProjectId === credential.projectId && Date.now() < this.catalogExpiresAt) {
      if (this.catalogFailureCode !== undefined) throw new LlmError('The Antigravity live model catalog refresh remains unavailable', this.catalogFailureCode)
      if (this.catalogLive !== undefined) return this.catalogLive
    }
    let response: Response
    const body = credential.projectId ? { project: credential.projectId } : {}
    try {
      response = await this.transport.request({
        url: ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT,
        accessToken: credential.accessToken,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
        responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs,
      })
    } catch (error) {
      const failure = toModelCatalogError(error, signal, 'provider')
      this.rememberCatalogFailure(credential.projectId, accountKey, failure)
      throw failure
    }
    if (response.status === 403 && credential.projectId) {
      try {
        const retryResponse = await this.transport.request({
          url: ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT,
          accessToken: credential.accessToken,
          body: JSON.stringify({}),
          ...(signal === undefined ? {} : { signal }),
          responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs,
        })
        if (retryResponse.ok) {
          await cancelResponse(response)
          response = retryResponse
        } else {
          await cancelResponse(retryResponse)
        }
      } catch (error) {
        const failure = toModelCatalogError(error, signal, 'provider')
        if (failure.code === 'CANCELLED' || failure.code === 'GATE_0_ATTRIBUTION') {
          await cancelResponse(response)
          this.rememberCatalogFailure(credential.projectId, accountKey, failure)
          throw failure
        }
        // Keep the original project-scoped 403 as the authoritative failure.
      }
    }
    const statusError = privateStatusError(response.status)
    if (statusError !== undefined) {
      await cancelResponse(response)
      if (statusError.code === 'authentication' && !forceCredentialRefresh && !isAborted(signal)) {
        this.catalogExpiresAt = 0
        return this.readLiveCatalog(signal, true, true)
      }
      const failure = toLlmError(statusError)
      this.rememberCatalogFailure(credential.projectId, accountKey, failure)
      throw failure
    }
    let value: unknown
    try {
      value = JSON.parse(await readPrivateText(response, {
        ...(signal === undefined ? {} : { signal }),
        idleTimeoutMs: this.options.idleTimeoutMs,
        totalTimeoutMs: this.options.totalTimeoutMs,
        maxBytes: Math.min(this.options.maxResponseBytes, MAX_MODEL_CATALOG_BYTES),
      })) as unknown
    } catch (error) {
      const failure = toModelCatalogError(error, signal, 'protocol')
      this.rememberCatalogFailure(credential.projectId, accountKey, failure)
      throw failure
    }
    let parsed: ParsedLiveCatalog
    try { parsed = parseLiveCatalog(value, this.definitions) } catch (error) {
      const failure = error instanceof LlmError
        ? error
        : new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
      this.rememberCatalogFailure(credential.projectId, accountKey, failure)
      throw failure
    }
    this.catalogProjectId = credential.projectId
    this.catalogAccountKey = accountKey
    this.catalogLive = parsed
    this.catalogFailureCode = undefined
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
    this.recordDynamicAndStaleCache(accountKey, parsed)
    return parsed
  }

  private rememberCatalogFailure(projectId: string, accountKey: string, failure: LlmError): void {
    if (failure.code === 'AUTH' || failure.code === 'CANCELLED') return
    this.catalogProjectId = projectId
    this.catalogAccountKey = accountKey
    this.catalogLive = undefined
    this.catalogFailureCode = failure.code
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
  }

  private recordDynamicAndStaleCache(accountKey: string, parsed: ParsedLiveCatalog): void {
    Object.assign(this.dynamicDefinitions, parsed.dynamicDefinitions)
    Object.assign(this.dynamicWireSpecs, parsed.dynamicWireSpecs)
    Object.assign(this.dynamicBaseByPublicId, parsed.modelBaseByPublicId)
    const checkedAt = new Date().toISOString()
    const liveView = createLiveCatalogView(this.definitions, parsed, checkedAt)
    const availableEntries = liveView.models
      .filter(entry => entry.state === 'live-available')
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        state: 'snapshot' as const,
      }))
    const cached: CachedLiveCatalog = {
      checkedAt,
      availableIds: [...parsed.availableIds],
      dynamicDefinitions: { ...parsed.dynamicDefinitions },
      dynamicWireSpecs: { ...parsed.dynamicWireSpecs },
      modelBaseByPublicId: { ...parsed.modelBaseByPublicId },
      catalogEntries: availableEntries,
    }
    this.staleCacheByKey.set(accountKey, cached)
    if (this.staleCacheByKey.size > 16) {
      const oldestKey = this.staleCacheByKey.keys().next().value
      if (oldestKey !== undefined) this.staleCacheByKey.delete(oldestKey)
    }
    this.savePersistedCatalogCache()
  }

  private resolveFallbackCache(accountKey: string | undefined): CachedLiveCatalog | undefined {
    if (accountKey === undefined) return undefined
    return this.staleCacheByKey.get(accountKey)
  }

  private buildFallbackCatalogView(state: AntigravityModelCatalogState, accountKey: string | undefined): AntigravityModelCatalogView {
    const cached = this.resolveFallbackCache(accountKey)
    if (cached !== undefined && cached.catalogEntries.length > 0) {
      return {
        state,
        cached: true,
        checkedAt: cached.checkedAt,
        models: cached.catalogEntries.map(entry => ({ ...entry, state: 'snapshot' as const })),
      }
    }
    return createCatalogView(this.definitions, state, undefined, new Date().toISOString())
  }

  private loadPersistedCatalogCache(): void {
    const filePath = this.adapterOptions.catalogCachePath
    if (filePath === undefined) return
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = parsePersistedCatalogFile(JSON.parse(raw))
      for (const [key, entry] of Object.entries(parsed)) {
        this.staleCacheByKey.set(key, entry)
        Object.assign(this.dynamicDefinitions, entry.dynamicDefinitions)
        Object.assign(this.dynamicWireSpecs, entry.dynamicWireSpecs)
        Object.assign(this.dynamicBaseByPublicId, entry.modelBaseByPublicId)
      }
    } catch {
      // Cache file is strictly advisory; missing or unreadable cache falls back cleanly.
    }
  }

  private savePersistedCatalogCache(): void {
    const filePath = this.adapterOptions.catalogCachePath
    if (filePath === undefined) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const entries: Record<string, CachedLiveCatalog> = {}
      for (const [key, value] of this.staleCacheByKey.entries()) entries[key] = value
      writeFileSync(filePath, JSON.stringify({ version: 1, accounts: entries }), { encoding: 'utf-8', mode: 0o600 })
    } catch {
      // Cache persistence is best-effort only.
    }
  }

  private clearPersistedCatalogCache(): void {
    const filePath = this.adapterOptions.catalogCachePath
    if (filePath === undefined) return
    try {
      unlinkSync(filePath)
    } catch {
      // Ignore missing cache file on logout/revoke.
    }
  }

  private async readCredential(signal: AbortSignal | undefined, forceRefresh: boolean, family?: string): Promise<HostCredential | undefined> {
    try {
      return await this.adapterOptions.auth.credential(signal, {
        ...(forceRefresh ? { forceRefresh: true } : {}),
        ...(family !== undefined ? { family } : {}),
      })
    } catch (error) {
      throw toLlmError(error)
    }
  }

  private async rotationBudget(): Promise<number> {
    const auth = this.adapterOptions.auth as AntigravityAuthCredentialSource
    if (typeof auth.accountCount !== 'function') return 1
    try {
      const count = await auth.accountCount()
      return Math.max(1, count)
    } catch {
      return 1
    }
  }

  private async tryRotate(family: string, status = 429, message = 'rate-limited'): Promise<boolean> {
    const auth = this.adapterOptions.auth as AntigravityAuthCredentialSource
    if (typeof auth.rotateOnFailure !== 'function') return false
    try {
      const decision = await auth.rotateOnFailure({ status, family, message })
      if (decision === 'rotate') {
        this.invalidateModelCatalog()
        return true
      }
    } catch {
      return false
    }
    return false
  }
}

type Gemini4ExtraEffort = 'low' | 'medium' | 'high' | 'xhigh'

interface ExtraGemini4WireSpec {
  readonly maxOutputTokens: number
  readonly modelEnum: string
  readonly thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH'
}

interface ExtraGemini4FamilySpec {
  readonly publicId: string
  readonly wireBase: string
  readonly displayName: string
  readonly defaultEffort: Gemini4ExtraEffort
  readonly efforts: readonly Gemini4ExtraEffort[]
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

const EFFORT_LABELS: Readonly<Record<Gemini4ExtraEffort, string>> = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
})

// Supplement @cortexkit/antigravity-auth-core@3.0.14 with Gemini 4 Hydrogen and Carbon models
// verified from Antigravity server catalogs and newer auth-core metadata without retiring 3.5 Flash.
const EXTRA_GEMINI4_FAMILIES: readonly ExtraGemini4FamilySpec[] = [
  {
    publicId: 'antigravity-gemini-4-hydrogen',
    wireBase: 'gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen (Antigravity)',
    defaultEffort: 'high',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
  },
  {
    publicId: 'antigravity-gemini-4-carbon',
    wireBase: 'gemini-4-carbon',
    displayName: 'Gemini 4 Carbon (Antigravity)',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high'],
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
  },
]

const EXTRA_GEMINI4_WIRE_SPECS: Readonly<Record<string, ExtraGemini4WireSpec>> = Object.freeze({
  'gemini-4-hydrogen-low': { maxOutputTokens: 262_144, modelEnum: 'MODEL_PLACEHOLDER_M527', thinkingLevel: 'LOW' },
  'gemini-4-hydrogen-medium': { maxOutputTokens: 262_144, modelEnum: 'MODEL_PLACEHOLDER_M526', thinkingLevel: 'MEDIUM' },
  'gemini-4-hydrogen-high': { maxOutputTokens: 262_144, modelEnum: 'MODEL_PLACEHOLDER_M525', thinkingLevel: 'HIGH' },
  'gemini-4-hydrogen-xhigh': { maxOutputTokens: 262_144, modelEnum: 'MODEL_PLACEHOLDER_M528', thinkingLevel: 'XHIGH' },
  'gemini-4-carbon-low': { maxOutputTokens: 262_144, modelEnum: 'MODEL_PLACEHOLDER_M438', thinkingLevel: 'LOW' },
  'gemini-4-carbon-medium': { maxOutputTokens: 262_144, modelEnum: 'MODEL_PLACEHOLDER_M437', thinkingLevel: 'MEDIUM' },
  'gemini-4-carbon-high': { maxOutputTokens: 262_144, modelEnum: 'MODEL_PLACEHOLDER_M427', thinkingLevel: 'HIGH' },
})

function findExtraGemini4Family(modelId: string): ExtraGemini4FamilySpec | undefined {
  const stripped = modelId.toLowerCase().replace(/^antigravity-/u, '')
  return EXTRA_GEMINI4_FAMILIES.find(
    family => stripped === family.wireBase || family.efforts.some(effort => stripped === `${family.wireBase}-${effort}`),
  )
}

function getExtraGemini4WireSpec(wireModel: string): ExtraGemini4WireSpec | undefined {
  const key = wireModel.toLowerCase()
  return Object.hasOwn(EXTRA_GEMINI4_WIRE_SPECS, key) ? EXTRA_GEMINI4_WIRE_SPECS[key] : undefined
}

function buildPublicModelDefinitions(): ReturnType<typeof getPublicModelDefinitions> {
  type PublicModelDefinitions = ReturnType<typeof getPublicModelDefinitions>
  type PublicModelEntry = PublicModelDefinitions[string]
  type PublicVariants = NonNullable<PublicModelEntry['variants']>

  const extraDefinitions: Record<string, PublicModelEntry> = {}
  for (const family of EXTRA_GEMINI4_FAMILIES) {
    const variants: Record<string, { thinkingLevel: string }> = {}
    for (const effort of family.efforts) {
      variants[effort] = { thinkingLevel: effort }
    }
    extraDefinitions[family.publicId] = {
      id: family.publicId,
      name: family.displayName,
      release_date: '',
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      cost: { input: 0, output: 0 },
      options: {},
      limit: { context: family.contextWindow, output: family.maxOutputTokens },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      variants: variants as PublicVariants,
    }
  }
  return {
    ...extraDefinitions,
    ...getPublicModelDefinitions(),
  }
}

function cleanModelDisplayName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/u, '').trim()
}

const DYNAMIC_EFFORT_ORDER: readonly Gemini4ExtraEffort[] = ['low', 'medium', 'high', 'xhigh']

function getModelReasoningEfforts(
  modelId: string,
  definition?: ReturnType<typeof getPublicModelDefinitions>[string],
): { efforts: readonly { id: ReturnType<typeof ReasoningEffortId>; name: string }[]; defaultEffort: ReturnType<typeof ReasoningEffortId> } | undefined {
  const extraFamily = findExtraGemini4Family(modelId)
  if (extraFamily !== undefined) {
    return {
      efforts: extraFamily.efforts.map(effort => ({
        id: ReasoningEffortId(effort),
        name: EFFORT_LABELS[effort],
      })),
      defaultEffort: ReasoningEffortId(extraFamily.defaultEffort),
    }
  }
  const lower = modelId.toLowerCase()
  if (lower.includes('gemini-4-argon') || (lower.includes('flash') && !lower.includes('image'))) {
    return {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId(
        lower.includes('gemini-4-argon') || lower.includes('gemini-3.8-flash') ? 'medium' : 'high',
      ),
    }
  }
  if (lower.includes('claude-sonnet-5-5') || lower.includes('claude-opus-5-5')) {
    return {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('low'),
    }
  }
  if (definition?.reasoning === true && isRecord(definition.variants)) {
    const keys = DYNAMIC_EFFORT_ORDER.filter(effort => Object.hasOwn(definition.variants!, effort))
    if (keys.length > 0) {
      const defaultEffort: Gemini4ExtraEffort = keys.includes('high') && keys.includes('xhigh')
        ? 'high'
        : keys.includes('medium')
          ? 'medium'
          : keys.includes('high')
            ? 'high'
            : keys[0]!
      return {
        efforts: keys.map(effort => ({
          id: ReasoningEffortId(effort),
          name: EFFORT_LABELS[effort],
        })),
        defaultEffort: ReasoningEffortId(defaultEffort),
      }
    }
  }
  return undefined
}

function toLlmModelInfo(definition: ReturnType<typeof getPublicModelDefinitions>[string]): LlmModelInfo {
  return {
    provider: ANTIGRAVITY_PROVIDER,
    id: definition.id,
    name: cleanModelDisplayName(definition.name),
    inputModalities: definition.modalities.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image'),
  }
}

function liveTextModelInfos(
  staticDefinitions: ReturnType<typeof getPublicModelDefinitions>,
  live: ParsedLiveCatalog,
): readonly LlmModelInfo[] {
  const seen = new Set<string>()
  const output: LlmModelInfo[] = []
  for (const definition of Object.values(staticDefinitions)) {
    if (definition.modalities.output.includes('image') || !live.availableIds.has(definition.id)) continue
    seen.add(definition.id)
    output.push(toLlmModelInfo(definition))
  }
  for (const id of live.dynamicModelOrder) {
    if (seen.has(id)) continue
    const definition = live.dynamicDefinitions[id]
    if (definition === undefined || definition.modalities.output.includes('image')) continue
    seen.add(id)
    output.push(toLlmModelInfo(definition))
  }
  return output
}

function createCatalogView(
  definitions: ReturnType<typeof getPublicModelDefinitions>,
  state: AntigravityModelCatalogState,
  available?: ReadonlySet<string>,
  checkedAt?: string,
): AntigravityModelCatalogView {
  const models = Object.values(definitions)
    .filter(definition => !definition.modalities.output.includes('image'))
    .slice(0, 64)
    .map(definition => ({
      id: definition.id,
      name: cleanModelDisplayName(definition.name),
      state: state === 'live-available'
        ? available?.has(definition.id) === true ? 'live-available' as const : 'unavailable' as const
        : 'snapshot' as const,
    }))
  return { state, models, ...(checkedAt === undefined ? {} : { checkedAt }) }
}

function createLiveCatalogView(
  staticDefinitions: ReturnType<typeof getPublicModelDefinitions>,
  live: ParsedLiveCatalog,
  checkedAt: string,
): AntigravityModelCatalogView {
  const models: AntigravityModelCatalogView['models'][number][] = []
  const seen = new Set<string>()
  for (const definition of Object.values(staticDefinitions)) {
    if (definition.modalities.output.includes('image')) continue
    seen.add(definition.id)
    models.push({
      id: definition.id,
      name: cleanModelDisplayName(definition.name),
      state: live.availableIds.has(definition.id) ? 'live-available' : 'unavailable',
    })
  }
  for (const id of live.dynamicModelOrder) {
    if (seen.has(id) || models.length >= 64) continue
    const definition = live.dynamicDefinitions[id]
    if (definition === undefined || definition.modalities.output.includes('image')) continue
    seen.add(id)
    models.push({
      id: definition.id,
      name: cleanModelDisplayName(definition.name),
      state: 'live-available',
    })
  }
  return { state: 'live-available', models, checkedAt }
}

function cloneCatalogView(value: AntigravityModelCatalogView): AntigravityModelCatalogView {
  return {
    state: value.state,
    models: value.models.map(model => ({ ...model })),
    ...(value.checkedAt === undefined ? {} : { checkedAt: value.checkedAt }),
    ...(value.cached === undefined ? {} : { cached: value.cached }),
  }
}

interface ParsedLiveCatalog {
  readonly availableIds: Set<string>
  readonly dynamicDefinitions: Record<string, ReturnType<typeof getPublicModelDefinitions>[string]>
  readonly dynamicWireSpecs: Record<string, DynamicWireSpec>
  readonly modelBaseByPublicId: Record<string, string>
  readonly dynamicModelOrder: string[]
}

interface DynamicModelAccumulator {
  readonly wireBase: string
  readonly publicId: string
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  supportsImages: boolean
  supportsThinking: boolean
  readonly efforts: Set<Gemini4ExtraEffort>
}

function parseLiveCatalog(
  value: unknown,
  definitions: ReturnType<typeof getPublicModelDefinitions>,
): ParsedLiveCatalog {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value
  if (!isRecord(root) || !isRecord(root.models)) throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
  const entries = Object.entries(root.models)
  if (entries.length > 512) throw new LlmError('The Antigravity live model catalog exceeded the model limit', 'PROTOCOL_DRIFT')
  const aliases = getResolverAliasMap()
  const live = new Set<string>()
  const activeEntries: Array<{ cleanId: string; rawEntry: Record<string, unknown> }> = []
  for (const [id, rawEntry] of entries) {
    if (!safeModelId(id) || !isRecord(rawEntry)) throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
    const cleanId = cleanModelId(id)
    if (rawEntry.modelName !== undefined && typeof rawEntry.modelName === 'string') {
      if (!safeModelId(rawEntry.modelName)) throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
    }
    if (rawEntry.displayName !== undefined && (typeof rawEntry.displayName !== 'string' || rawEntry.displayName.length > 512 || containsControl(rawEntry.displayName))) {
      throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
    }
    if (rawEntry.disabled === true || cleanId.endsWith('-disabled')) continue
    live.add(canonicalWireModel(cleanId, aliases))
    live.add(cleanId)
    live.add(id)
    if (cleanId === 'gemini-3-flash' || cleanId === 'gemini-3-flash-agent' || cleanId.startsWith('gemini-3-flash') || cleanId.startsWith('gemini-3.5-flash')) {
      live.add('gemini-3.5-flash')
      live.add('gemini-3-flash-agent')
      live.add('gemini-3.5-flash-low')
      live.add('gemini-3.5-flash-extra-low')
    }
    if (cleanId === 'gemini-3.8-flash-tiered' || cleanId.startsWith('gemini-3.8-flash')) {
      live.add('gemini-3.8-flash')
      live.add('gemini-3.8-flash-medium')
      live.add('gemini-3.8-flash-low')
      live.add('gemini-3.8-flash-high')
    }
    if (cleanId.startsWith('gemini-4-argon')) {
      live.add('gemini-4-argon')
      live.add('gemini-4-argon-low')
      live.add('gemini-4-argon-medium')
      live.add('gemini-4-argon-high')
    }
    for (const family of EXTRA_GEMINI4_FAMILIES) {
      if (cleanId === family.wireBase || cleanId.startsWith(`${family.wireBase}-`)) {
        live.add(family.wireBase)
        for (const effort of family.efforts) {
          live.add(`${family.wireBase}-${effort}`)
        }
      }
    }
    if (cleanId.startsWith('claude-sonnet-5-5')) {
      live.add('claude-sonnet-5-5')
      live.add('claude-sonnet-5-5-low')
      live.add('claude-sonnet-5-5-medium')
      live.add('claude-sonnet-5-5-high')
    }
    if (cleanId.startsWith('claude-opus-5-5')) {
      live.add('claude-opus-5-5')
      live.add('claude-opus-5-5-low')
      live.add('claude-opus-5-5-medium')
      live.add('claude-opus-5-5-high')
    }
    if (rawEntry.modelName !== undefined && typeof rawEntry.modelName === 'string') {
      const cleanName = cleanModelId(rawEntry.modelName)
      live.add(canonicalWireModel(cleanName, aliases))
      live.add(cleanName)
    }
    activeEntries.push({ cleanId, rawEntry })
  }
  const available = new Set<string>()
  const staticWireRoots = new Set<string>()
  for (const definition of Object.values(definitions)) {
    const resolved = resolveWireModel(definition.id)
    const cleanResolved = cleanModelId(resolved)
    const canonical = canonicalWireModel(cleanResolved, aliases)
    const strippedDefBase = definition.id.toLowerCase().replace(/^antigravity-/u, '').replace(/-(?:minimal|low|medium|high|xhigh)$/iu, '')
    staticWireRoots.add(cleanResolved.toLowerCase().replace(/-(?:minimal|low|medium|high|xhigh)$/iu, ''))
    staticWireRoots.add(strippedDefBase)
    if (
      live.has(canonical)
      || live.has(cleanResolved)
      || live.has(resolved)
      || live.has(definition.id)
      || (definition.id === 'antigravity-gemini-3.5-flash' && (
        live.has('gemini-3-flash')
        || live.has('gemini-3-flash-agent')
        || live.has('gemini-3.5-flash')
        || live.has('gemini-3.5-flash-low')
        || live.has('gemini-3.5-flash-extra-low')
      ))
    ) {
      available.add(definition.id)
    }
  }
  const dynamicWireSpecs: Record<string, DynamicWireSpec> = {}
  const groups = new Map<string, DynamicModelAccumulator>()
  const dynamicModelOrder: string[] = []
  for (const { cleanId, rawEntry } of activeEntries) {
    if (rawEntry.isInternal === true || cleanId.startsWith('tab_') || isImageModelId(cleanId) || isRetiredAgyModel(cleanId)) continue
    if (!isDiscoverableServerModel(cleanId, rawEntry)) continue
    const lower = cleanId.toLowerCase()
    const effortMatch = lower.match(/^(.+?)-(minimal|low|medium|high|xhigh)$/iu)
    const rawEffort = effortMatch?.[2]
    const effort: Gemini4ExtraEffort | undefined = rawEffort === 'minimal' ? 'low' : rawEffort as Gemini4ExtraEffort | undefined
    const spec = extractDynamicWireSpec(rawEntry, effort)
    if (spec !== undefined) {
      dynamicWireSpecs[lower] = spec
    }
    const candidateWireBase = effortMatch !== null ? cleanId.slice(0, effortMatch[1]!.length) : cleanId
    const lowerBase = candidateWireBase.toLowerCase()
    if (matchesStaticDefinition(lower, lowerBase, aliases, staticWireRoots, definitions)) {
      continue
    }
    const publicId = candidateWireBase.startsWith('antigravity-') ? candidateWireBase : `antigravity-${candidateWireBase}`
    let group = groups.get(publicId)
    const displayName = typeof rawEntry.displayName === 'string' && rawEntry.displayName.trim().length > 0
      ? cleanModelDisplayName(rawEntry.displayName)
      : candidateWireBase
    const contextWindow = positiveBoundedInt(rawEntry.maxTokens, 1_048_576, 10_000_000)
    const maxOutputTokens = positiveBoundedInt(rawEntry.maxOutputTokens, 65_536, 1_000_000)
    if (group === undefined) {
      group = {
        wireBase: candidateWireBase,
        publicId,
        displayName,
        contextWindow,
        maxOutputTokens,
        supportsImages: rawEntry.supportsImages !== false,
        supportsThinking: rawEntry.supportsThinking === true || effort !== undefined,
        efforts: new Set(),
      }
      groups.set(publicId, group)
      dynamicModelOrder.push(publicId)
    } else {
      group.contextWindow = Math.max(group.contextWindow, contextWindow)
      group.maxOutputTokens = Math.max(group.maxOutputTokens, maxOutputTokens)
      if (rawEntry.supportsImages === false) group.supportsImages = false
      if (rawEntry.supportsThinking === true || effort !== undefined) group.supportsThinking = true
    }
    if (effort !== undefined) group.efforts.add(effort)
  }

  const dynamicDefinitions: Record<string, ReturnType<typeof getPublicModelDefinitions>[string]> = {}
  const modelBaseByPublicId: Record<string, string> = {}
  for (const publicId of dynamicModelOrder) {
    const group = groups.get(publicId)
    if (group === undefined) continue
    const sortedEfforts = DYNAMIC_EFFORT_ORDER.filter(item => group.efforts.has(item))
    const variants: Record<string, { thinkingLevel: string }> = {}
    for (const effort of sortedEfforts) variants[effort] = { thinkingLevel: effort }
    const definition: ReturnType<typeof getPublicModelDefinitions>[string] = {
      id: publicId,
      name: group.displayName,
      release_date: '',
      attachment: group.supportsImages,
      reasoning: group.supportsThinking,
      temperature: true,
      tool_call: true,
      cost: { input: 0, output: 0 },
      options: {},
      limit: { context: group.contextWindow, output: group.maxOutputTokens },
      modalities: {
        input: group.supportsImages ? ['text', 'image', 'pdf'] : ['text'],
        output: ['text'],
      },
    }
    if (sortedEfforts.length > 0) {
      definition.variants = variants as NonNullable<ReturnType<typeof getPublicModelDefinitions>[string]['variants']>
    }
    dynamicDefinitions[publicId] = definition
    modelBaseByPublicId[publicId] = group.wireBase
    available.add(publicId)
  }
  return { availableIds: available, dynamicDefinitions, dynamicWireSpecs, modelBaseByPublicId, dynamicModelOrder }
}

function accountCacheKey(credential: HostCredential): string {
  return createHash('sha256')
    .update(`antigravity-catalog-v1/${credential.projectId}/${credential.refreshToken}`)
    .digest('hex')
    .slice(0, 16)
}

function isImageModelId(cleanId: string): boolean {
  const lower = cleanId.toLowerCase()
  return lower.startsWith('imagen') || /(?:^|-)image(?:$|-)/u.test(lower)
}

function isDiscoverableServerModel(cleanId: string, rawEntry: Record<string, unknown>): boolean {
  const lower = cleanId.toLowerCase()
  if (
    lower.startsWith('gemini-')
    || lower.startsWith('claude-')
    || lower.startsWith('gpt-oss-')
  ) {
    return true
  }
  return (
    (typeof rawEntry.model === 'string' && rawEntry.model.length > 0 && rawEntry.model.length <= 256 && !containsControl(rawEntry.model))
    || typeof rawEntry.maxTokens === 'number'
    || typeof rawEntry.maxOutputTokens === 'number'
    || (typeof rawEntry.modelProvider === 'string' && rawEntry.modelProvider.length > 0)
    || (typeof rawEntry.apiProvider === 'string' && rawEntry.apiProvider.length > 0)
  )
}

function positiveBoundedInt(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value
    : fallback
}

function extractDynamicWireSpec(rawEntry: Record<string, unknown>, effort: Gemini4ExtraEffort | undefined): DynamicWireSpec | undefined {
  const modelEnum = typeof rawEntry.model === 'string' && rawEntry.model.length > 0 && rawEntry.model.length <= 256 && !containsControl(rawEntry.model)
    ? rawEntry.model
    : undefined
  const maxOutputTokens = typeof rawEntry.maxOutputTokens === 'number' && Number.isSafeInteger(rawEntry.maxOutputTokens) && rawEntry.maxOutputTokens > 0 && rawEntry.maxOutputTokens <= 1_000_000
    ? rawEntry.maxOutputTokens
    : undefined
  const rawThinkingLevel = typeof rawEntry.thinkingLevel === 'string' ? rawEntry.thinkingLevel.toUpperCase() : undefined
  const thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH' | undefined = rawThinkingLevel === 'LOW' || rawThinkingLevel === 'MEDIUM' || rawThinkingLevel === 'HIGH' || rawThinkingLevel === 'XHIGH'
    ? rawThinkingLevel
    : effort === undefined
      ? undefined
      : (effort.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH')
  const supportsThinking = typeof rawEntry.supportsThinking === 'boolean' ? rawEntry.supportsThinking : undefined
  if (modelEnum === undefined && maxOutputTokens === undefined && thinkingLevel === undefined && supportsThinking === undefined) {
    return undefined
  }
  return {
    ...(modelEnum === undefined ? {} : { modelEnum }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
  }
}

function matchesStaticDefinition(
  lowerCleanId: string,
  lowerBase: string,
  aliases: Readonly<Record<string, string>>,
  staticWireRoots: ReadonlySet<string>,
  definitions: ReturnType<typeof getPublicModelDefinitions>,
): boolean {
  const canonical = canonicalWireModel(lowerCleanId, aliases).toLowerCase()
  if (
    staticWireRoots.has(lowerCleanId)
    || staticWireRoots.has(lowerBase)
    || staticWireRoots.has(canonical)
    || Object.hasOwn(definitions, lowerCleanId)
    || Object.hasOwn(definitions, `antigravity-${lowerCleanId}`)
    || Object.hasOwn(definitions, `antigravity-${lowerBase}`)
  ) {
    return true
  }
  if (lowerCleanId.startsWith('gemini-3-flash') || lowerCleanId.startsWith('gemini-3.5-flash') || lowerCleanId.startsWith('gemini-3.8-flash')) return true
  if (lowerCleanId.startsWith('gemini-4-argon') || lowerCleanId.startsWith('claude-sonnet-5-5') || lowerCleanId.startsWith('claude-opus-5-5')) return true
  if (findExtraGemini4Family(lowerCleanId) !== undefined || findExtraGemini4Family(lowerBase) !== undefined) return true
  return false
}

function parsePersistedCatalogFile(value: unknown): Record<string, CachedLiveCatalog> {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.accounts)) return {}
  const output: Record<string, CachedLiveCatalog> = {}
  let count = 0
  for (const [key, rawAccount] of Object.entries(value.accounts)) {
    if (count >= 16 || !/^[a-f0-9]{16}$/u.test(key) || !isRecord(rawAccount)) continue
    if (typeof rawAccount.checkedAt !== 'string' || Number.isNaN(Date.parse(rawAccount.checkedAt))) continue
    if (!Array.isArray(rawAccount.availableIds) || rawAccount.availableIds.length > 64) continue
    if (!Array.isArray(rawAccount.catalogEntries) || rawAccount.catalogEntries.length === 0 || rawAccount.catalogEntries.length > 64) continue
    const availableIds: string[] = []
    for (const id of rawAccount.availableIds) {
      if (safeModelId(id)) availableIds.push(id)
    }
    const catalogEntries: AntigravityModelCatalogView['models'][number][] = []
    for (const rawEntry of rawAccount.catalogEntries) {
      if (!isRecord(rawEntry) || !safeModelId(rawEntry.id) || typeof rawEntry.name !== 'string' || rawEntry.name.length === 0 || rawEntry.name.length > 256 || containsControl(rawEntry.name)) continue
      catalogEntries.push({ id: rawEntry.id, name: rawEntry.name, state: 'snapshot' })
    }
    if (catalogEntries.length === 0) continue
    const dynamicDefinitions = isRecord(rawAccount.dynamicDefinitions)
      ? rawAccount.dynamicDefinitions as Record<string, ReturnType<typeof getPublicModelDefinitions>[string]>
      : {}
    const dynamicWireSpecs = isRecord(rawAccount.dynamicWireSpecs)
      ? rawAccount.dynamicWireSpecs as Record<string, DynamicWireSpec>
      : {}
    const modelBaseByPublicId = isRecord(rawAccount.modelBaseByPublicId)
      ? rawAccount.modelBaseByPublicId as Record<string, string>
      : {}
    output[key] = {
      checkedAt: rawAccount.checkedAt,
      availableIds,
      dynamicDefinitions,
      dynamicWireSpecs,
      modelBaseByPublicId,
      catalogEntries,
    }
    count += 1
  }
  return output
}

function cleanModelId(value: string): string {
  return value.replace(/^(?:publishers\/[^/]+\/)?models\//, '')
}

function canonicalWireModel(value: string, aliases: Readonly<Record<string, string>>): string {
  return aliases[value] ?? value
}

function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !containsControl(value)
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

interface BlockState {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  readonly id: ReturnType<typeof ToolCallId>
  name?: string
  text: string
  signature?: string
}

function beginBlock(states: BlockState[], part: ProviderPart): BlockState {
  const index = states.length
  const block: BlockState = part.kind === 'tool-call'
    ? {
        index,
        kind: 'tool-call',
        id: ToolCallId(part.id ?? `antigravity-call-${String(index)}`),
        ...(part.name === undefined ? {} : { name: part.name }),
        text: '',
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      }
    : {
        index,
        kind: part.kind,
        id: ToolCallId(`antigravity-block-${String(index)}`),
        text: '',
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      }
  states.push(block)
  return block
}

function sameBlock(state: BlockState, part: ProviderPart): boolean {
  if (state.kind !== part.kind) return false
  return part.kind !== 'tool-call' || (part.id === undefined || part.id === String(state.id))
}

function assembleFunctionName(current: string | undefined, fragment: string): string {
  if (fragment.length === 0 || fragment.length > 256 || containsControl(fragment)) {
    throw new PrivateTransportError('protocol-drift', 'The private tool-call name was invalid')
  }
  if (current === undefined || current.length === 0) return fragment
  if (fragment === current) return current
  if (fragment.startsWith(current)) return fragment
  const combined = `${current}${fragment}`
  if (combined.length > 256) throw new PrivateTransportError('protocol-drift', 'The private tool-call name exceeded the byte limit')
  return combined
}

function endBlock(state: BlockState): StreamChunk {
  if (state.kind === 'text') return { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }
  if (state.kind === 'reasoning') return { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } }
  let parsed: unknown
  try {
    parsed = JSON.parse(state.text) as unknown
  } catch {
    throw new PrivateTransportError('protocol-drift', 'The private tool-call arguments were incomplete JSON')
  }
  if (!isRecord(parsed)) throw new PrivateTransportError('protocol-drift', 'The private tool-call arguments were not an object')
  const args = state.text
  if (state.name === undefined || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u.test(state.name)) {
    throw new PrivateTransportError('protocol-drift', 'The private tool-call name was missing or invalid')
  }
  return {
    type: 'block-end',
    index: state.index,
    block: {
      type: 'tool-call',
      id: state.id,
      name: state.name,
      arguments: args,
    },
  }
}

/**
 * Build the model-facing functionResponse payload.
 * Gemini's FunctionResponse.response is a free-form Struct with no dedicated error
 * field, so a failed tool result is reported under `error` and a successful one
 * under `content`; both remain readable to the model.
 */
function toolResponsePayload(content: unknown, isError?: boolean): Record<string, unknown> {
  return isError === true ? { error: content } : { content }
}

const IMAGE_OFFLOAD_REQUIRED_CODE = ((dshLlm as Record<string, unknown>).IMAGE_OFFLOAD_REQUIRED_CODE as string | undefined) ?? 'IMAGE_OFFLOAD_REQUIRED'

function safeProjectOffloadedImages(messages: readonly Message[], placeholder: (ref: ImageAttachmentRef) => string): readonly Message[] {
  if (typeof (dshLlm as Record<string, unknown>).projectOffloadedImages === 'function') {
    return ((dshLlm as Record<string, unknown>).projectOffloadedImages as (msgs: readonly Message[], p: (ref: ImageAttachmentRef) => string) => readonly Message[])(messages, placeholder)
  }
  return messages.map(message => {
    let replaced = false
    const content = message.content.map(block => {
      if (block.type === 'image' && (block as unknown as { offloaded?: boolean }).offloaded === true) {
        replaced = true
        return { type: 'text' as const, text: placeholder(block.attachment as ImageAttachmentRef) }
      }
      return block
    })
    return replaced ? { ...message, content } : message
  })
}

function safeRequiredImageOffload(
  messages: readonly Message[],
  budget: { representation: string; maxBytes: number },
  versionBytes: (block: unknown) => number,
): number {
  if (typeof (dshLlm as Record<string, unknown>).requiredImageOffload === 'function') {
    return ((dshLlm as Record<string, unknown>).requiredImageOffload as (msgs: readonly Message[], b: typeof budget, vb: typeof versionBytes) => number)(messages, budget, versionBytes)
  }
  let totalBytes = 0
  const imageSizes: number[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' && (block as unknown as { offloaded?: boolean }).offloaded !== true) {
        const raw = versionBytes(block)
        const bytes = budget.representation === 'base64' ? Math.ceil(raw * 4 / 3) : raw
        totalBytes += bytes
        imageSizes.push(bytes)
      }
    }
  }
  let count = 0
  let excess = totalBytes - budget.maxBytes
  for (const size of imageSizes) {
    if (excess <= 0) break
    count += 1
    excess -= size
  }
  return count
}

function safeOffloadedImageText(ref: ImageAttachmentRef, access: unknown): string {
  if (typeof (dshLlm as Record<string, unknown>).offloadedImageText === 'function') {
    return ((dshLlm as Record<string, unknown>).offloadedImageText as (r: ImageAttachmentRef, a: unknown) => string)(ref, access)
  }
  const name = ref.name !== undefined ? `${JSON.stringify(ref.name)} (${ref.attachmentId})` : String(ref.attachmentId)
  return `[image omitted to fit request image limits; ${name}.]`
}

function safeResolveImageAttachmentAccess(
  attachments: Pick<AttachmentStore, 'readImage'> | undefined,
  mapHostPath: (hostPath: string) => string | undefined,
  ref: ImageAttachmentRef,
): unknown {
  if (attachments === undefined) return undefined
  if (typeof (dshLlm as Record<string, unknown>).resolveImageAttachmentAccess === 'function') {
    return ((dshLlm as Record<string, unknown>).resolveImageAttachmentAccess as Function)(attachments, mapHostPath, ref)
  }
  const hostPath = (attachments as unknown as { imageHostPath?(r: ImageAttachmentRef): string | undefined }).imageHostPath?.(ref)
  if (hostPath === undefined) return undefined
  const readonlyPath = mapHostPath(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

function boundedRequestBytes(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_PRIVATE_REQUEST_BYTES
}

/**
 * Oldest-first image count the private route must offload before its image payload fits.
 * Uses the Host's own image-only budget instead of blaming total request bytes on images.
 */
function antigravityImageOffloadCount(messages: readonly Message[], sentBytes: ReadonlyMap<string, number> | undefined): number {
  return safeRequiredImageOffload(messages, {
    representation: 'base64',
    maxBytes: ANTIGRAVITY_INLINE_IMAGE_BYTES,
  }, (block: unknown) => {
    const attachment = isRecord(block) && isRecord((block as Record<string, unknown>).attachment) ? ((block as Record<string, unknown>).attachment as Record<string, unknown>) : undefined
    const attachmentId = attachment && typeof attachment.attachmentId === 'string' ? attachment.attachmentId : undefined
    const sent = attachmentId === undefined ? undefined : sentBytes?.get(attachmentId)
    if (typeof sent === 'number') return sent
    return attachment && typeof attachment.bytes === 'number' ? attachment.bytes : 0
  })
}

/** Resolve a read-only execution-world path so an offloaded image stays recoverable by tools. */
function resolveAntigravityImageAccess(
  attachments: Pick<AttachmentStore, 'readImage'> | undefined,
  fs: Pick<FileSystem, 'processPathFromHostPath'> | undefined,
  ref: ImageAttachmentRef,
): unknown {
  if (attachments === undefined || fs === undefined) return undefined
  try {
    return safeResolveImageAttachmentAccess(attachments, (hostPath: string) => fs.processPathFromHostPath(hostPath), ref)
  } catch {
    return undefined
  }
}

export function buildAntigravityGeneratePayload(
  options: GenerateOptions,
  credential: HostCredential,
  attachments?: Pick<AttachmentStore, 'readImage'>,
  fs?: Pick<FileSystem, 'processPathFromHostPath'>,
): Record<string, unknown> {
  const toolNames = new Map<string, ToolCallState>()
  const history = safeProjectOffloadedImages(options.messages, (ref: ImageAttachmentRef) => safeOffloadedImageText(ref, resolveAntigravityImageAccess(attachments, fs, ref)))
  const contents = (history as readonly Message[])
    .filter((message: Message) => message.role !== 'system')
    .map((message: Message) => mapMessage(message, options.model, toolNames))
  return buildPayloadFromContents(options, credential, contents)
}

async function buildAntigravityGeneratePayloadForAdapter(
  options: GenerateOptions,
  credential: HostCredential,
  session: Parameters<typeof buildAgyAgentRequestMetadata>[0],
  timestamp: number,
  attachments: (Pick<AttachmentStore, 'readImage'> & {
    readImageRequest?(ref: ImageAttachmentRef, bounds: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
  }) | undefined,
  fs?: Pick<FileSystem, 'processPathFromHostPath'>,
  dynamicCatalog?: DynamicCatalogContext,
): Promise<Record<string, unknown> & { sentImageBytes?: Map<string, number> }> {
  /** Downscaled byte length actually sent per attachment; requiredImageOffload applies base64Length itself. */
  const sentImageBytes = new Map<string, number>()
  const contents: Record<string, unknown>[] = []
  const toolNames = new Map<string, ToolCallState>()
  const history = safeProjectOffloadedImages(options.messages, (ref: ImageAttachmentRef) => safeOffloadedImageText(ref, resolveAntigravityImageAccess(attachments, fs, ref)))
  for (const message of (history as readonly Message[])) {
    if (message.role === 'system') continue
    contents.push(await mapMessageWithAttachments(message, options.model, toolNames, attachments, options.signal, sentImageBytes))
  }
  const wireModel = resolveWireModel(options.model, options.reasoningEffort, dynamicCatalog)
  const payload = buildPayloadFromContents(options, credential, contents, dynamicCatalog)
  const metadata = buildAgyAgentRequestMetadata(session, payload.request as Record<string, unknown>, wireModel, timestamp)
  const extraWireSpec = getExtraGemini4WireSpec(wireModel)
  const dynamicWireSpec = dynamicCatalog?.wireSpecs[wireModel.toLowerCase()]
  const request = payload.request as Record<string, unknown>
  const resolvedModelEnum = metadata.labels.model_enum ?? extraWireSpec?.modelEnum ?? dynamicWireSpec?.modelEnum
  request.labels = metadata.labels.model_enum === undefined && resolvedModelEnum !== undefined
    ? { ...metadata.labels, model_enum: resolvedModelEnum }
    : metadata.labels
  request.sessionId = metadata.sessionId
  orderAgyRequestPayloadInPlace(request)
  return {
    ...(payload.project === undefined ? {} : { project: payload.project }),
    requestId: metadata.requestId,
    request,
    model: payload.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    sentImageBytes,
  }
}

function groupClaudeFunctionResponses(
  contents: readonly Record<string, unknown>[],
  model: string,
): readonly Record<string, unknown>[] {
  if (antigravityModelFamily(model) !== 'claude') return contents
  const grouped: Record<string, unknown>[] = []
  let pendingResponses: Record<string, unknown>[] = []
  const flushResponses = (): void => {
    if (pendingResponses.length === 0) return
    grouped.push({ role: 'user', parts: pendingResponses })
    pendingResponses = []
  }
  for (const content of contents) {
    const rawParts = Array.isArray(content.parts) ? content.parts : []
    const responseParts = rawParts.filter(part => isRecord(part) && isRecord(part.functionResponse)) as Record<string, unknown>[]
    const responseOnly = content.role === 'user' && rawParts.length > 0 && responseParts.length === rawParts.length
    if (responseOnly) {
      pendingResponses.push(...responseParts)
      continue
    }
    flushResponses()
    grouped.push(content)
  }
  flushResponses()
  return grouped
}

function buildPayloadFromContents(
  options: GenerateOptions,
  credential: HostCredential,
  contents: readonly Record<string, unknown>[],
  dynamicCatalog?: DynamicCatalogContext,
): Record<string, unknown> {
  const wireModel = resolveWireModel(options.model, options.reasoningEffort, dynamicCatalog)
  const usesCapturedGemini38ThinkingBudget = /^gemini-3\.8-flash-(?:low|medium|high)$/u.test(wireModel)
  const requestContents = groupClaudeFunctionResponses(contents, options.model)
  const request: Record<string, unknown> = { contents: requestContents }
  // V3 AgentLoop stores instructions in system messages. One-shot callers may
  // still provide a separate preface; preserve both in their original order.
  const systemParts = [
    ...(options.system?.trim() ? [{ text: options.system }] : []),
    ...options.messages.flatMap(message => message.role === 'system'
      ? message.content.flatMap(block => block.type === 'text' && block.text.trim() ? [{ text: block.text }] : [])
      : []),
  ]
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts }
  const generationConfig: Record<string, unknown> = {}
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = boundedInteger(options.maxTokens, 1, 1_000_000, 'maxTokens')
  else if (usesCapturedGemini38ThinkingBudget) generationConfig.maxOutputTokens = 65536
  if (options.temperature !== undefined) generationConfig.temperature = boundedNumber(options.temperature, -100, 100, 'temperature')
  if (options.stop !== undefined) generationConfig.stopSequences = options.stop.slice(0, 16).map(item => item.slice(0, 256))
  if (options.reasoningEffort !== undefined) generationConfig.thinkingConfig = { thinkingLevel: String(options.reasoningEffort) }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  if (options.tools !== undefined && options.tools.length > 0) {
    const declarations = buildFunctionDeclarations(options.tools)
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
  }
  const tieredModel = resolveModelForTier(options.model, options.reasoningEffort)
  const resolved = resolveModelWithTier(usesCapturedGemini38ThinkingBudget ? wireModel : tieredModel)
  const nativeModel = getAgyNativeModel(wireModel)
  const extraWireSpec = getExtraGemini4WireSpec(wireModel)
  const dynamicWireSpec = dynamicCatalog?.wireSpecs[wireModel.toLowerCase()]
  const usesAdaptiveNativeThinking = isGeminiArgonModel(wireModel)
    || nativeModel?.supportsAdaptiveThinking === true
    || extraWireSpec !== undefined
    || dynamicWireSpec?.thinkingLevel !== undefined
  const usesNumericGeminiThinkingBudget = !wireModel.toLowerCase().includes('claude') && !usesAdaptiveNativeThinking && typeof resolved.thinkingBudget === 'number'
  const requestedEffort = resolveEffortForModel(options.model, options.reasoningEffort)
  const thinkingLevel = requestedEffort ?? resolved.thinkingLevel
  if (wireModel.toLowerCase().includes('claude')) {
    applyClaudeToolHardening(request)
    applyClaudeTransforms(request, {
      model: wireModel,
      ...(resolved.thinkingBudget === undefined || usesAdaptiveNativeThinking ? {} : { tierThinkingBudget: resolved.thinkingBudget }),
      ...(usesAdaptiveNativeThinking || (options.reasoningEffort === undefined && resolved.thinkingBudget === undefined) ? {} : { normalizedThinking: { includeThoughts: true, ...(resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }) } }),
      cleanJSONSchema: cleanClaudeSchema,
    })
    if (usesAdaptiveNativeThinking) {
      const transformedConfig = isRecord(request.generationConfig) ? request.generationConfig : {}
      applyAgyNativeGenerationConfig(wireModel, transformedConfig)
      request.generationConfig = transformedConfig
    }
  } else {
    applyGeminiTransforms(request, {
      model: wireModel,
      ...(thinkingLevel === undefined || usesNumericGeminiThinkingBudget || usesAdaptiveNativeThinking ? {} : { tierThinkingLevel: thinkingLevel as 'low' | 'medium' | 'high' }),
      ...(resolved.thinkingBudget === undefined || usesAdaptiveNativeThinking ? {} : { tierThinkingBudget: resolved.thinkingBudget }),
      ...(usesAdaptiveNativeThinking || (options.reasoningEffort === undefined && resolved.thinkingBudget === undefined) ? {} : { normalizedThinking: { includeThoughts: true, ...(resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }) } }),
    })
    if (usesAdaptiveNativeThinking) {
      const transformedConfig = isRecord(request.generationConfig) ? request.generationConfig : {}
      if (extraWireSpec !== undefined) {
        if (transformedConfig.maxOutputTokens === undefined) {
          transformedConfig.maxOutputTokens = extraWireSpec.maxOutputTokens
        }
        transformedConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingLevel: extraWireSpec.thinkingLevel,
        }
      } else if (dynamicWireSpec !== undefined) {
        if (transformedConfig.maxOutputTokens === undefined && dynamicWireSpec.maxOutputTokens !== undefined) {
          transformedConfig.maxOutputTokens = dynamicWireSpec.maxOutputTokens
        }
        if (dynamicWireSpec.thinkingLevel !== undefined && dynamicWireSpec.supportsThinking !== false) {
          transformedConfig.thinkingConfig = {
            includeThoughts: true,
            thinkingLevel: dynamicWireSpec.thinkingLevel,
          }
        }
      } else {
        applyAgyNativeGenerationConfig(wireModel, transformedConfig)
      }
      request.generationConfig = transformedConfig
    } else if (usesNumericGeminiThinkingBudget && typeof resolved.thinkingBudget === 'number') {
      const transformedConfig = isRecord(request.generationConfig) ? request.generationConfig : {}
      transformedConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: resolved.thinkingBudget }
      request.generationConfig = transformedConfig
    }
    if (dynamicWireSpec?.maxOutputTokens !== undefined) {
      const transformedConfig = isRecord(request.generationConfig) ? request.generationConfig : {}
      if (transformedConfig.maxOutputTokens === undefined) {
        transformedConfig.maxOutputTokens = dynamicWireSpec.maxOutputTokens
        request.generationConfig = transformedConfig
      }
    }
  }
  const project = credential.projectId === 'inductive-dreamer-qrkws' || !credential.projectId ? undefined : credential.projectId
  return { ...(project === undefined ? {} : { project }), model: wireModel, request }
}

function applyClaudeToolHardening(request: Record<string, unknown>): void {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return
  request.tools = request.tools.map(tool => {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return tool
    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map(declaration => hardenClaudeToolDeclaration(declaration)),
    }
  })
  const instructionPart = { text: CLAUDE_TOOL_SYSTEM_INSTRUCTION }
  const existing = request.systemInstruction
  if (isRecord(existing) && Array.isArray(existing.parts)) {
    if (existing.parts.some(part => isRecord(part) && typeof part.text === 'string' && part.text.includes('CRITICAL TOOL USAGE INSTRUCTIONS'))) return
    request.systemInstruction = { ...existing, parts: [...existing.parts, instructionPart] }
  } else if (typeof existing === 'string') {
    request.systemInstruction = { role: 'user', parts: [{ text: existing }, instructionPart] }
  } else {
    request.systemInstruction = { role: 'user', parts: [instructionPart] }
  }
}

function prepareClaudeSchema(value: unknown): unknown {
  if (!isRecord(value)) return value
  const copy: Record<string, unknown> = { ...value }
  if (isRecord(copy.properties)) {
    const props: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(copy.properties)) {
      props[key] = prepareClaudeSchema(item)
    }
    copy.properties = props
  }
  if (copy.items !== undefined) {
    copy.items = prepareClaudeSchema(copy.items)
  }
  const unionKey = Array.isArray(copy.anyOf) ? 'anyOf' : Array.isArray(copy.oneOf) ? 'oneOf' : undefined
  if (unionKey !== undefined) {
    const rawBranches = (copy[unionKey] as unknown[]).map(branch => prepareClaudeSchema(branch))
    const branches = rawBranches.filter(isRecord)
    const { anyOf: _anyOf, oneOf: _oneOf, ...base } = copy
    if (
      branches.length > 1
      && branches.every(branch => typeof branch.type === 'string' && branch.type.toLowerCase() === 'object')
    ) {
      const mergedProps: Record<string, unknown> = {}
      for (const branch of branches) {
        if (!isRecord(branch.properties)) continue
        for (const [key, prop] of Object.entries(branch.properties)) {
          const existing = mergedProps[key]
          if (existing === undefined) {
            mergedProps[key] = prop
          } else if (isRecord(existing) && isRecord(prop) && Array.isArray(existing.enum) && Array.isArray(prop.enum)) {
            mergedProps[key] = {
              ...existing,
              enum: [...new Set([...existing.enum, ...prop.enum])],
            }
          }
        }
      }
      const reqSets = branches.map(branch => new Set(
        Array.isArray(branch.required) ? branch.required.filter((item): item is string => typeof item === 'string') : [],
      ))
      const commonRequired = [...(reqSets[0] ?? [])].filter(
        req => reqSets.every(set => set.has(req)) && Object.prototype.hasOwnProperty.call(mergedProps, req),
      )
      return {
        ...base,
        type: 'object',
        properties: mergedProps,
        ...(commonRequired.length > 0 ? { required: commonRequired } : {}),
      }
    }
    if (
      branches.length > 1
      && branches.every(branch => typeof branch.type === 'string' && branch.type.toLowerCase() === 'string' && !branch.properties && !branch.items)
      && branches.some(branch => !Array.isArray(branch.enum))
      && branches.some(branch => Array.isArray(branch.enum) && branch.enum.length > 0)
    ) {
      const enums = [...new Set(branches.flatMap(branch => Array.isArray(branch.enum) ? branch.enum.filter((item): item is string => typeof item === 'string') : []))]
      const hint = `Allowed presets: ${enums.map(item => JSON.stringify(item)).join(', ')}`
      const baseDesc = typeof base.description === 'string' ? base.description : ''
      return {
        ...base,
        type: 'string',
        description: baseDesc ? `${baseDesc} (${hint})` : hint,
      }
    }
    copy[unionKey] = rawBranches
  }
  return copy
}

function cleanClaudeSchema(value: unknown): Record<string, unknown> {
  const prepared = prepareClaudeSchema(value)
  const cleaned = toGeminiSchema(prepared, { claudeValidated: true })
  return isRecord(cleaned) ? cleaned : { type: 'object', properties: {} }
}

function hardenClaudeToolDeclaration(value: unknown): unknown {
  if (!isRecord(value)) return value
  const description = typeof value.description === 'string' ? value.description : ''
  if (description.includes('STRICT PARAMETERS:')) return value
  const schema = isRecord(value.parameters) ? cleanClaudeSchema(value.parameters) : undefined
  const properties = schema !== undefined && isRecord(schema.properties) ? schema.properties : undefined
  if (properties === undefined || Object.keys(properties).length === 0) return value
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter(item => typeof item === 'string') : [])
  const parameters = Object.entries(properties).map(([name, property]) => {
    const requiredHint = required.has(name) ? ', REQUIRED' : ''
    return `${name} (${claudeToolTypeHint(property)}${requiredHint})`
  })
  return {
    ...value,
    description: description + CLAUDE_DESCRIPTION_PROMPT.replace('{params}', parameters.join(', ')),
  }
}

function claudeToolTypeHint(value: unknown): string {
  if (!isRecord(value)) return 'unknown'
  if (Array.isArray(value.enum)) {
    return value.enum.length <= 5
      ? `string ENUM[${value.enum.map(item => JSON.stringify(item)).join(', ')}]`
      : `string ENUM[${value.enum.length} options]`
  }
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : 'unknown'
  if (type === 'array') {
    if (!isRecord(value.items)) return 'ARRAY'
    const itemType = typeof value.items.type === 'string' ? value.items.type.toLowerCase() : 'unknown'
    if (itemType !== 'object') return `ARRAY_OF_${itemType.toUpperCase()}`
    if (!isRecord(value.items.properties)) return 'ARRAY_OF_OBJECTS'
    const nestedRequired = new Set(Array.isArray(value.items.required) ? value.items.required.filter(item => typeof item === 'string') : [])
    const nested = Object.entries(value.items.properties).map(([name, property]) => {
      const nestedType = isRecord(property) && typeof property.type === 'string' ? property.type.toLowerCase() : 'unknown'
      return `${name}: ${nestedType}${nestedRequired.has(name) ? ' REQUIRED' : ''}`
    })
    return `ARRAY_OF_OBJECTS[${nested.join(', ')}]`
  }
  if (type === 'object' && isRecord(value.properties)) {
    const nestedRequired = new Set(Array.isArray(value.required) ? value.required.filter(item => typeof item === 'string') : [])
    const nested = Object.entries(value.properties).map(([name, property]) => {
      const nestedType = isRecord(property) && typeof property.type === 'string' ? property.type.toLowerCase() : 'unknown'
      return `${name}: ${nestedType}${nestedRequired.has(name) ? ' REQUIRED' : ''}`
    })
    return `object{${nested.join(', ')}}`
  }
  return type
}

function mapMessage(message: Message, model: string, toolNames: Map<string, ToolCallState>): Record<string, unknown> {
  /** Calls of a new assistant message are the only ones its results may answer. */
  if (message.role === 'assistant') expirePendingToolCalls(toolNames)
  const parts: Record<string, unknown>[] = []
  const replay = compatibleReplayState(message, ANTIGRAVITY_PROVIDER, model, contentKinds(message))
  const replayBlocks = replay?.blocks ?? []
  const isClaude = antigravityModelFamily(model) === 'claude'
  let replayIndex = 0
  /** A tool message answers one call; emit that response once and keep any remaining blocks. */
  let emittedToolResponse = false
  if ((message as unknown as { role?: string }).role === 'tool' && typeof (message as unknown as { toolCallId?: string }).toolCallId === 'string' && ((message as unknown as { toolCallId: string }).toolCallId.length > 0)) {
    const toolCallId = requireToolCallId((message as unknown as { toolCallId: string }).toolCallId)
    /** A tool message with no prior call of that id is skipped, not an error. */
    const binding = toolNames.has(toolCallId) ? consumeToolBinding(toolNames, toolCallId) : undefined
    if (binding !== undefined) {
      emittedToolResponse = true
      parts.push({
        functionResponse: {
          ...(isClaude ? { id: binding.id } : {}),
          name: binding.name,
          response: toolResponsePayload(blocksToText(message.content), (message as unknown as { isError?: boolean }).isError),
        },
      })
    }
  }
  let sawClaudeFunctionCall = false
  for (const block of message.content) {
    const replayKind = block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? block.type : undefined
    const replayBlock = replayKind === undefined ? undefined : replayBlocks[replayIndex++]
    const replaySignature = replayBlock !== undefined && replayBlock.kind === replayKind ? replayBlock.signature : undefined
    const blockSignature = (block as unknown as { signature?: string; thoughtSignature?: string }).signature
      ?? (block as unknown as { signature?: string; thoughtSignature?: string }).thoughtSignature
      ?? replaySignature
    if (block.type === 'text') {
      /** Text already reached the model through the tool response above. */
      if (emittedToolResponse) continue
      if (block.text.length === 0 && message.content.length > 1) continue
      parts.push({ text: block.text, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'reasoning') {
      if (isClaude && blockSignature === undefined) continue
      parts.push({ text: block.text, thought: true, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'tool-call') {
      const callId = rememberToolName(toolNames, block.id, block.name)
      /** Every family needs a signature here: the endpoint rejects unsigned functionCall parts with 400 INVALID_ARGUMENT. */
      const signature = isClaude && sawClaudeFunctionCall ? undefined : (blockSignature ?? SKIP_THOUGHT_SIGNATURE)
      sawClaudeFunctionCall ||= isClaude
      parts.push({
        functionCall: {
          ...(isClaude ? { id: callId } : {}),
          name: block.name,
          args: parseJsonObject(block.arguments),
        },
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      })
    } else if (block.type === 'tool-result') {
      /** A role='tool' message was already answered as a whole; its block must not consume the call again. */
      if (emittedToolResponse) continue
      const binding = consumeToolBinding(toolNames, block.toolCallId)
      parts.push({
        functionResponse: {
          ...(isClaude ? { id: binding.id } : {}),
          name: binding.name,
          response: toolResponsePayload(blocksToText(block.content), block.isError),
        },
      })
    } else if (block.type === 'image') {
      throw new LlmError('Antigravity text requests do not accept unresolved image blocks', 'UNSUPPORTED_MODALITY')
    }
  }
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts,
  }
}

async function mapMessageWithAttachments(
  message: Message,
  model: string,
  toolNames: Map<string, ToolCallState>,
  attachments: (Pick<AttachmentStore, 'readImage'> & {
    readImageRequest?(ref: ImageAttachmentRef, bounds: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
  }) | undefined,
  signal: AbortSignal | undefined,
  sentImageBytes?: Map<string, number>,
): Promise<Record<string, unknown>> {
  if (!message.content.some(block => block.type === 'image')) return mapMessage(message, model, toolNames)
  if (attachments === undefined) throw new LlmError('Antigravity image input requires the Host AttachmentStore', 'UNSUPPORTED_MODALITY')
  /** Calls of a new assistant message are the only ones its results may answer. */
  if (message.role === 'assistant') expirePendingToolCalls(toolNames)
  const replay = compatibleReplayState(message, ANTIGRAVITY_PROVIDER, model, contentKinds(message))
  const replayBlocks = replay?.blocks ?? []
  const parts: Record<string, unknown>[] = []
  const isClaude = antigravityModelFamily(model) === 'claude'
  let replayIndex = 0
  /** A tool message answers one call; emit that response once and keep any remaining blocks. */
  let emittedToolResponse = false
  if ((message as unknown as { role?: string }).role === 'tool' && typeof (message as unknown as { toolCallId?: string }).toolCallId === 'string' && ((message as unknown as { toolCallId: string }).toolCallId.length > 0)) {
    const toolCallId = requireToolCallId((message as unknown as { toolCallId: string }).toolCallId)
    /** A tool message with no prior call of that id is skipped, not an error. */
    const binding = toolNames.has(toolCallId) ? consumeToolBinding(toolNames, toolCallId) : undefined
    if (binding !== undefined) {
      emittedToolResponse = true
      parts.push({
        functionResponse: {
          ...(isClaude ? { id: binding.id } : {}),
          name: binding.name,
          response: toolResponsePayload(blocksToText(message.content), (message as unknown as { isError?: boolean }).isError),
        },
      })
    }
  }
  let sawClaudeFunctionCall = false
  for (const block of message.content) {
    const replayKind = block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? block.type : undefined
    const replayBlock = replayKind === undefined ? undefined : replayBlocks[replayIndex++]
    const replaySignature = replayBlock !== undefined && replayBlock.kind === replayKind ? replayBlock.signature : undefined
    const blockSignature = (block as unknown as { signature?: string; thoughtSignature?: string }).signature
      ?? (block as unknown as { signature?: string; thoughtSignature?: string }).thoughtSignature
      ?? replaySignature
    if (block.type === 'image') {
      const ref = block.attachment as ImageAttachmentRef
      let mediaType: string
      let encoded: string
      if (typeof attachments.readImageRequest === 'function') {
        const stored = await attachments.readImageRequest(ref, {
          ...requestImageDimensions(ref.width, ref.height, ANTIGRAVITY_REQUEST_IMAGE_MAX_PIXELS),
          maxBytes: ANTIGRAVITY_REQUEST_IMAGE_MAX_BYTES,
        }, signal)
        mediaType = stored.mediaType
        encoded = Buffer.from(stored.data).toString('base64')
        sentImageBytes?.set(ref.attachmentId, stored.data.byteLength)
      } else {
        const stored = await attachments.readImage(ref as never, signal)
        mediaType = stored.ref.mediaType
        encoded = Buffer.from(stored.data).toString('base64')
        sentImageBytes?.set(ref.attachmentId, stored.data.byteLength)
      }
      parts.push({ inlineData: { mimeType: mediaType, data: encoded } })
    } else if (block.type === 'text') {
      /** Text already reached the model through the tool response above. */
      if (emittedToolResponse) continue
      if (block.text.length === 0 && message.content.length > 1) continue
      parts.push({ text: block.text, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'reasoning') {
      if (isClaude && blockSignature === undefined) continue
      parts.push({ text: block.text, thought: true, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'tool-call') {
      const callId = rememberToolName(toolNames, block.id, block.name)
      /** Every family needs a signature here: the endpoint rejects unsigned functionCall parts with 400 INVALID_ARGUMENT. */
      const signature = isClaude && sawClaudeFunctionCall ? undefined : (blockSignature ?? SKIP_THOUGHT_SIGNATURE)
      sawClaudeFunctionCall ||= isClaude
      parts.push({
        functionCall: {
          ...(isClaude ? { id: callId } : {}),
          name: block.name,
          args: parseJsonObject(block.arguments),
        },
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      })
    } else if (block.type === 'tool-result') {
      /** A role='tool' message was already answered as a whole; its block must not consume the call again. */
      if (emittedToolResponse) continue
      const binding = consumeToolBinding(toolNames, block.toolCallId)
      parts.push({
        functionResponse: {
          ...(isClaude ? { id: binding.id } : {}),
          name: binding.name,
          response: toolResponsePayload(blocksToText(block.content), block.isError),
        },
      })
    }
  }
  return { role: message.role === 'assistant' ? 'model' : 'user', parts }
}

/** The wire identity of the latest call under one raw provider id, for the call and for its answer. */
interface ToolCallBinding {
  readonly id: string
  readonly name: string
}

/** Every unanswered call under one raw provider id, in call order, plus the most recent binding. */
interface ToolCallState {
  last: ToolCallBinding
  pending: ToolCallBinding[]
}

function rememberToolName(toolNames: Map<string, ToolCallState>, callId: unknown, name: string): string {
  if (name.length === 0 || name.length > 256 || containsControl(name)) throw new LlmError('The tool call name is invalid', 'INVALID_ARGS')
  const id = requireToolCallId(callId)
  const state = toolNames.get(id)
  /**
   * Provider call ids are unique per request, not across a durable history: the
   * same id legitimately reappears under another tool name. Suffixing the later
   * occurrence keeps every call addressable by its own answer instead of failing
   * the whole turn, and the suffix derives only from the ordered history, so a
   * rebuilt request reproduces the same ids byte for byte. A name that repeats
   * after a conflict keeps its own assigned id rather than reclaiming the raw id
   * still carried by the first call.
   */
  const assigned = state === undefined ? id : state.last.name === name ? state.last.id : `${id}#${name}`
  const binding = { id: assigned, name }
  toolNames.set(id, { last: binding, pending: [...(state?.pending ?? []), binding] })
  return assigned
}

/**
 * Pair one tool result with the call it answers. Only calls made by the same
 * assistant message can share a raw id and still need in-order pairing, so the
 * queue is expired at every new assistant message and an unanswered call from an
 * earlier message can no longer claim a later result.
 */
function consumeToolBinding(toolNames: Map<string, ToolCallState>, callId: unknown): ToolCallBinding {
  const state = toolNames.get(requireToolCallId(callId))
  if (state === undefined) throw new LlmError('A tool result did not match a prior tool call', 'INVALID_ARGS')
  const next = state.pending.shift()
  return next ?? state.last
}

/**
 * Drop calls left unanswered by any earlier assistant message before reading this one.
 *
 * This relies on the Host committing every result of one step in the same step
 * (`dsh-agent-loop` awaits `executeToolCalls`, and a max-tokens step returns
 * before dispatching anything), so a call and its answer never straddle two
 * assistant messages. If results ever become asynchronously committed, an
 * unanswered call could legitimately outlive its message and this expiry would
 * have to pair by call order instead.
 */
function expirePendingToolCalls(toolNames: Map<string, ToolCallState>): void {
  for (const state of toolNames.values()) {
    if (state.pending.length > 0) state.pending = []
  }
}

function requireToolCallId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || containsControl(value)) {
    throw new LlmError('The tool call id is invalid', 'INVALID_ARGS')
  }
  return value
}

function normalizeReasoningEffort(value: GenerateOptions['reasoningEffort']): Gemini4ExtraEffort | undefined {
  if (value === undefined) return undefined
  const normalized = String(value).toLowerCase()
  if (normalized === 'minimal' || normalized === 'low') return 'low'
  if (normalized === 'medium') return 'medium'
  if (normalized === 'high') return 'high'
  if (normalized === 'xhigh') return 'xhigh'
  return undefined
}

function resolveEffortForModel(
  model: string,
  reasoningEffort?: GenerateOptions['reasoningEffort'],
): Gemini4ExtraEffort | undefined {
  const effort = normalizeReasoningEffort(reasoningEffort)
  if (effort === undefined) return undefined
  const extraFamily = findExtraGemini4Family(model)
  if (extraFamily !== undefined) {
    return extraFamily.efforts.includes(effort) ? effort : undefined
  }
  return effort === 'xhigh' ? undefined : effort
}

function resolveModelForTier(model: string, reasoningEffort?: GenerateOptions['reasoningEffort']): string {
  const effort = resolveEffortForModel(model, reasoningEffort)
  if (effort === undefined || /-(?:minimal|low|medium|high|xhigh)$/iu.test(model)) return model
  const extraFamily = findExtraGemini4Family(model)
  if (extraFamily !== undefined) {
    return `${model}-${effort}`
  }
  if (
    /^(?:antigravity-)?gemini-3\.[58]-flash$/iu.test(model)
    || /^(?:antigravity-)?gemini-4-argon$/iu.test(model)
    || /^(?:antigravity-)?claude-(?:opus|sonnet)-5-5$/iu.test(model)
  ) {
    return `${model}-${effort}`
  }
  return model
}

function resolveWireModel(
  model: string,
  reasoningEffort?: GenerateOptions['reasoningEffort'],
  dynamicCatalog?: DynamicCatalogContext,
): string {
  const extraFamily = findExtraGemini4Family(model)
  if (extraFamily !== undefined) {
    const stripped = model.toLowerCase().replace(/^antigravity-/u, '')
    if (getExtraGemini4WireSpec(stripped) !== undefined || dynamicCatalog?.wireSpecs[stripped] !== undefined) return stripped
    const effort = resolveEffortForModel(model, reasoningEffort) ?? extraFamily.defaultEffort
    return `${extraFamily.wireBase}-${effort}`
  }
  const dynamicDefinition = dynamicCatalog?.definitions[model]
  if (dynamicDefinition !== undefined) {
    const wireBase = dynamicCatalog?.modelBaseByPublicId[model] ?? model.replace(/^antigravity-/u, '')
    const normalizedEffort = normalizeReasoningEffort(reasoningEffort)
    const variants = dynamicDefinition.variants
    if (variants !== undefined) {
      if (normalizedEffort !== undefined && Object.hasOwn(variants, normalizedEffort)) {
        const candidate = `${wireBase}-${normalizedEffort}`
        if (dynamicCatalog?.wireSpecs[candidate.toLowerCase()] !== undefined) return candidate
        return candidate
      }
      const effortInfo = getModelReasoningEfforts(model, dynamicDefinition)
      if (effortInfo !== undefined) {
        return `${wireBase}-${effortInfo.defaultEffort}`
      }
    }
    return wireBase
  }
  const stripped = model.replace(/^antigravity-/u, '')
  if (dynamicCatalog?.wireSpecs[stripped.toLowerCase()] !== undefined) return stripped
  const routeModel = resolveModelForTier(model, reasoningEffort)
  return resolveModelWithTier(routeModel).actualModel
}

function requestSessionKey(options: GenerateOptions): string {
  return options.sessionId === undefined ? 'default' : `session:${fnv1a64Signed(String(options.sessionId))}`
}

function contentKinds(message: Message): Array<'text' | 'reasoning' | 'tool-call'> {
  return message.content.flatMap(block => block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? [block.type] : [])
}

function parseProviderEvent(data: string): ProviderEvent {
  const normalized = data.trim().replace(/^\)\]\}'(?:\r?\n)?/u, '')
  let value: unknown
  try { value = JSON.parse(normalized) as unknown } catch {
    throw new PrivateTransportError('invalid-response', 'The private response contained invalid JSON')
  }
  if (!isRecord(value)) throw new PrivateTransportError('protocol-drift', 'The private response event was not an object')
  if (isRecord(value.error)) return { parts: [], error: errorDetails(value.error) }
  const root = isRecord(value.response) ? value.response : value
  if (isRecord(root.error)) return { parts: [], error: errorDetails(root.error) }
  const partsValue = findParts(root)
  const parts: ProviderPart[] = []
  for (const part of partsValue) {
    const parsed = parsePart(part)
    if (parsed !== undefined) parts.push(parsed)
  }
  const usage = parseUsage(root.usageMetadata ?? value.usageMetadata)
  const finish = findFinish(root)
  return {
    parts,
    ...(usage === undefined ? {} : { usage }),
    ...(finish === undefined ? {} : { finish }),
  }
}

function findParts(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.parts)) return boundedParts(value.parts)
  if (isRecord(value.content) && Array.isArray(value.content.parts)) return boundedParts(value.content.parts)
  if (isRecord(value.modelTurn) && Array.isArray(value.modelTurn.parts)) return boundedParts(value.modelTurn.parts)
  if (Array.isArray(value.candidates)) {
    const output: unknown[] = []
    for (const candidate of value.candidates) {
      if (!isRecord(candidate)) continue
      const content = isRecord(candidate.content) ? candidate.content : candidate
      if (Array.isArray(content.parts)) {
        if (output.length + content.parts.length > MAX_PROVIDER_PARTS) throw new PrivateTransportError('protocol-drift', 'The private response contained too many parts')
        output.push(...content.parts)
      }
    }
    return output
  }
  if (isRecord(value.serverContent) && isRecord(value.serverContent.modelTurn) && Array.isArray(value.serverContent.modelTurn.parts)) {
    return boundedParts(value.serverContent.modelTurn.parts)
  }
  return []
}

function boundedParts(value: unknown[]): unknown[] {
  if (value.length > MAX_PROVIDER_PARTS) throw new PrivateTransportError('protocol-drift', 'The private response contained too many parts')
  return value
}

function parsePart(value: unknown): ProviderPart | undefined {
  if (!isRecord(value)) throw new PrivateTransportError('protocol-drift', 'The private response part was malformed')
  const functionCall = isRecord(value.functionCall) ? value.functionCall : isRecord(value.function_call) ? value.function_call : undefined
  if (functionCall !== undefined) {
    const name = stringValue(functionCall.name)
    const id = stringValue(functionCall.id)
    const signature = signatureOf(value) ?? signatureOf(functionCall)
    const args = typeof functionCall.args === 'string' ? functionCall.args : JSON.stringify(functionCall.args ?? {})
    return {
      kind: 'tool-call',
      ...(name === undefined ? {} : { name }),
      ...(id === undefined ? {} : { id }),
      arguments: args,
      ...(signature === undefined ? {} : { signature }),
    }
  }
  if (typeof value.text === 'string' || signatureOf(value) !== undefined) {
    const kind = value.thought === true || value.reasoning === true || value.thinking === true ? 'reasoning' as const : 'text' as const
    const signature = signatureOf(value)
    const text = typeof value.text === 'string' ? value.text : ''
    return { kind, text, ...(signature === undefined ? {} : { signature }) }
  }
  if (value.inlineData !== undefined || value.inline_data !== undefined) {
    throw new PrivateTransportError('protocol-drift', 'The text model returned unsupported media output')
  }
  throw new PrivateTransportError('protocol-drift', 'The private response contained an unknown part type')
}

function errorDetails(value: Record<string, unknown>): NonNullable<ProviderEvent['error']> {
  const status = numberValue(value.status)
  const code = stringValue(value.code)
  const contextWindowExceeded = providerErrorReportsContextWindowExceeded(value, 0)
  return {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(contextWindowExceeded ? { contextWindowExceeded: true } : {}),
  }
}

async function responseReportsContextWindowExceeded(
  response: Response,
  options: {
    readonly signal?: AbortSignal
    readonly idleTimeoutMs: number
    readonly totalTimeoutMs: number
    readonly maxResponseBytes: number
    readonly maxFrameBytes: number
  },
): Promise<boolean> {
  try {
    for await (const event of iteratePrivateSse(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      idleTimeoutMs: options.idleTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      maxBytes: Math.min(MAX_PROVIDER_ERROR_BYTES, options.maxResponseBytes),
      maxFrameBytes: Math.min(MAX_PROVIDER_ERROR_FRAME_BYTES, options.maxFrameBytes),
    })) {
      const payload = event.data.replace(/^\)\]\}'(?:\r?\n)?/u, '')
      if (providerErrorEnvelopeReportsContextWindowExceeded(payload, 0)) return true
    }
    return false
  } catch (error) {
    if (error instanceof PrivateTransportError && error.code === 'cancelled') throw toLlmError(error)
    if (isAborted(options.signal)) throw new LlmError('The Antigravity request was cancelled', 'CANCELLED')
    return false
  }
}

function providerErrorReportsContextWindowExceeded(value: Record<string, unknown>, depth: number): boolean {
  if (depth > MAX_PROVIDER_ERROR_JSON_DEPTH) return false
  if (typeof value.message === 'string') {
    if (isExactContextWindowExceededMessage(value.message)) return true
    if (providerErrorEnvelopeReportsContextWindowExceeded(value.message, depth + 1)) return true
  }
  return isRecord(value.error) && providerErrorReportsContextWindowExceeded(value.error, depth + 1)
}

function providerErrorEnvelopeReportsContextWindowExceeded(value: string, depth: number): boolean {
  if (depth > MAX_PROVIDER_ERROR_JSON_DEPTH || value.length === 0 || value.length > MAX_PROVIDER_ERROR_BYTES) return false
  const json = value.trim()
  if (!json.startsWith('{') || !jsonDepthIsBounded(json, MAX_PROVIDER_ERROR_JSON_DEPTH)) return false
  try {
    const parsed = JSON.parse(json) as unknown
    return isRecord(parsed) && isRecord(parsed.error)
      ? providerErrorReportsContextWindowExceeded(parsed.error, depth + 1)
      : false
  } catch {
    return false
  }
}

function isExactContextWindowExceededMessage(value: string): boolean {
  const match = /^prompt is too long: ([0-9]{1,16}) tokens > ([0-9]{1,16}) maximum$/u.exec(value)
  const actual = match?.[1]
  const maximum = match?.[2]
  return actual !== undefined && maximum !== undefined && BigInt(actual) > BigInt(maximum)
}

function jsonDepthIsBounded(value: string, maxDepth: number): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{' || character === '[') {
      depth += 1
      if (depth > maxDepth) return false
    } else if (character === '}' || character === ']') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0 && !inString && !escaped
}

function contextWindowExceededError(status?: number): LlmError {
  const message = 'The Antigravity request exceeded the model context window'
  return status === undefined
    ? new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
    : new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, { status })
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = numberValue(value.promptTokenCount ?? value.inputTokenCount)
  const output = numberValue(value.candidatesTokenCount ?? value.outputTokenCount)
  const reasoning = numberValue(value.thoughtsTokenCount ?? value.reasoningTokenCount)
  const cached = numberValue(value.cachedContentTokenCount ?? value.cacheReadTokens)
  if (input === undefined && output === undefined && reasoning === undefined && cached === undefined) return undefined
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function findFinish(value: Record<string, unknown>): string | undefined {
  const candidate = value.finishReason ?? value.finish_reason
  if (typeof candidate === 'string') return candidate
  if (isRecord(value.serverContent) && typeof value.serverContent.finishReason === 'string') return value.serverContent.finishReason
  if (Array.isArray(value.candidates)) {
    for (const item of value.candidates) if (isRecord(item) && typeof item.finishReason === 'string') return item.finishReason
  }
  return undefined
}

function signatureOf(value: Record<string, unknown>): string | undefined {
  return stringValue(value.thoughtSignature ?? value.thought_signature ?? value.signature)
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // The provider must never receive silently rewritten historical tool calls.
  }
  throw new LlmError('The Antigravity tool-call history is malformed', 'PROTOCOL_DRIFT')
}

function blocksToText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').slice(0, 64 * 1024)
}

function isAuthenticationCode(value: string | undefined): boolean {
  const normalized = value?.toUpperCase()
  return normalized === 'UNAUTHENTICATED' || normalized === 'AUTHENTICATION' || normalized === 'INVALID_GRANT' || normalized === 'UNAUTHENTICATED_REQUEST'
}


function mapFinishReason(value: string | undefined): FinishReason['kind'] {
  const normalized = value?.toUpperCase()
  if (normalized === 'MAX_TOKENS' || normalized === 'LENGTH') return 'max-tokens'
  if (normalized === 'SAFETY' || normalized === 'BLOCKLIST' || normalized === 'ERROR') return 'error'
  if (normalized === 'TOOL_CALLS' || normalized === 'FUNCTION_CALL') return 'tool-calls'
  return 'stop'
}

function finishChunk(
  kind: FinishReason['kind'],
  code: string,
  status?: number,
  replayState?: ReplayEnvelope,
): StreamChunk {
  const reason: FinishReason = kind === 'aborted'
    ? { kind: 'aborted', failure: { code, message: 'The Antigravity request was cancelled' } }
    : kind === 'error'
      ? { kind: 'error', failure: { code, message: 'The Antigravity provider request failed', ...(status === undefined ? {} : { status }) } }
      : kind === 'max-tokens'
        ? { kind: 'max-tokens' }
        : kind === 'tool-calls'
          ? { kind: 'tool-calls' }
          : { kind: 'stop' }
  return { type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) }
}

const LLM_FAILURE_CODES: Readonly<Record<PrivateFailureKind, string>> = {
  authentication: 'AUTH',
  forbidden: 'FORBIDDEN',
  'rate-limited': 'RATE_LIMIT',
  cancelled: 'CANCELLED',
  timeout: 'TIMEOUT',
  'attribution-rejected': 'GATE_0_ATTRIBUTION',
  'protocol-drift': 'PROTOCOL_DRIFT',
  'response-limit': 'RESPONSE_LIMIT',
  'request-limit': 'REQUEST_LIMIT',
  upstream: 'UPSTREAM',
  network: 'TRANSPORT',
  failed: 'PROVIDER_ERROR',
}

function canFallBackToPinnedTextSnapshot(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  return error.code === 'RATE_LIMIT'
    || error.code === 'TIMEOUT'
    || error.code === 'PROTOCOL_DRIFT'
    || error.code === 'RESPONSE_LIMIT'
    || error.code === 'UPSTREAM'
    || error.code === 'TRANSPORT'
}

function toModelCatalogError(
  error: unknown,
  signal: AbortSignal | undefined,
  fallback: 'provider' | 'protocol',
): LlmError {
  if (isAborted(signal)) return new LlmError('The Antigravity live model catalog request was cancelled', 'CANCELLED')
  if (error instanceof LlmError) return error
  if (error instanceof PrivateTransportError || fallback === 'provider') return toLlmError(error)
  return new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof PrivateTransportError) {
    const kind = classifyPrivateFailure(error)
    const code = LLM_FAILURE_CODES[kind]
    // Surface the failure class (and HTTP status when present) so operators can
    // tell network drops from auth or quota failures without reading logs.
    const detail = error.status === undefined ? ` (${code})` : ` (${code}, status ${error.status})`
    const message = kind === 'rate-limited'
      ? 'Antigravity rate limit reached (Google returned 429 Resource Exhausted); please wait for your quota window to refresh'
      : `The Antigravity private request failed safely${detail}`
    return error.status === undefined
      ? new LlmError(message, code)
      : new LlmError(message, code, { status: error.status })
  }
  return new LlmError('The Antigravity provider request failed safely', 'PROVIDER_ERROR')
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), 10 * 60 * 1000)
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), fallback)
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new LlmError(`The Antigravity ${field} option is invalid`, 'INVALID_OPTIONS')
  return value
}

function boundedNumber(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new LlmError(`The Antigravity ${field} option is invalid`, 'INVALID_OPTIONS')
  return value
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 && !containsControl(value) ? value : undefined
}

function safeProviderErrorCode(value: string | undefined): string {
  const normalized = value?.toUpperCase()
  return normalized === 'SAFETY' || normalized === 'BLOCKED' || normalized === 'RESOURCE_EXHAUSTED' || normalized === 'INVALID_ARGUMENT'
    ? normalized
    : 'UPSTREAM_ERROR'
}

function safeProviderStatus(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined
}

async function cancelResponse(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* best effort before a bounded replay */ }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof PrivateTransportError)) return false
  return error.code === 'offline' || error.code === 'timeout' || error.code === 'upstream'
}

async function waitRetryBackoff(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
