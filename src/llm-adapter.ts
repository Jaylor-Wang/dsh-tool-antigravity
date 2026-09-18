import { Buffer } from "node:buffer";
import {
  AgyRequestSessionStore,
  type AgyRequestSessionContext,
  applyClaudeTransforms,
  applyGeminiTransforms,
  buildAgyAgentRequestMetadata,
  fnv1a64Signed,
  orderAgyRequestPayloadInPlace,
  resolveModelWithTier,
  SKIP_THOUGHT_SIGNATURE,
  type ThinkingTier
} from "@cortexkit/antigravity-auth-core";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
  type ReplayEnvelope,
  ToolCallId,
  resolveRetryPolicy
} from "@deepseek-ai/dsh-llm";
import {
  cleanModelDisplayName,
  cloneCatalogView,
  createCatalogView,
  getModelReasoningEfforts,
  getPublicModelDefinitions,
  lookupModelDefinition,
  MAX_MODEL_CATALOG_BYTES,
  MODEL_CATALOG_TTL_MS,
  normalizeReasoningEffort,
  parseLiveModelIds,
  resolveWireModel,
  type CatalogView
} from "./model-catalog.js";
import { classifyPrivateFailure } from "./private-failure.js";
import {
  DEFAULT_PRIVATE_FRAME_BYTES,
  DEFAULT_PRIVATE_IDLE_TIMEOUT_MS,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS,
  DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS,
  createPrivateTransport,
  iteratePrivateSse,
  privateStatusError,
  readPrivateText,
  PrivateTransportError,
  type PrivateTransport
} from "./private-transport.js";
import {
  antigravityModelFamily,
  applyClaudeToolHardening,
  buildFunctionDeclarations,
  compatibleReplayState,
  createReplayState,
  groupClaudeFunctionResponses
} from "./replay.js";
import { isRecord } from "./safe-text.js";
import { ANTIGRAVITY_WIRE_ORIGIN } from "./wire-identity.js";

export const ANTIGRAVITY_PROVIDER = "google-antigravity";
export const ANTIGRAVITY_STREAM_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:streamGenerateContent?alt=sse`;
export const ANTIGRAVITY_GENERATE_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:generateContent`;
export const ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:fetchAvailableModels`;
export const ANTIGRAVITY_LLM_ROUTE = ANTIGRAVITY_PROVIDER;

const MAX_PROVIDER_ERROR_BYTES = 65536;
const MAX_PROVIDER_ERROR_FRAME_BYTES = 16384;
const MAX_PROVIDER_ERROR_JSON_DEPTH = 8;
const MAX_PROVIDER_PARTS = 4096;

export interface AntigravityCredential {
  accessToken: string;
  projectId?: string;
  email?: string;
}

export interface AntigravityAdapterAuth {
  credential(signal?: AbortSignal, options?: { forceRefresh?: boolean }): Promise<AntigravityCredential | undefined>;
}

export interface AntigravityAttachmentStore {
  readImage(attachment: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; ref: { mediaType: string } }>;
}

export interface AntigravityAdapterOptions {
  auth: AntigravityAdapterAuth;
  transport?: PrivateTransport;
  attachments?: AntigravityAttachmentStore;
  responseHeaderTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  maxFrameBytes?: number;
}

interface ProviderToolCallPart {
  kind: "tool-call";
  name?: string;
  arguments: string;
  id?: string;
  signature?: string;
}

interface ProviderTextPart {
  kind: "text" | "reasoning";
  text: string;
  signature?: string;
}

type ProviderPart = ProviderToolCallPart | ProviderTextPart;

interface ProviderEvent {
  parts: ProviderPart[];
  usage?: TokenUsage;
  finish?: string;
  error?: {
    status?: number;
    code?: string;
    contextWindowExceeded?: boolean;
  };
}

interface BlockState {
  index: number;
  kind: "text" | "reasoning" | "tool-call";
  id: ToolCallId;
  name?: string;
  text: string;
  signature?: string;
}

export class AntigravityAdapter extends LlmAdapter {
  private readonly adapterOptions: AntigravityAdapterOptions;
  private readonly transport: PrivateTransport;
  private readonly sessions = new AgyRequestSessionStore("dsh-tool-antigravity");
  private readonly options: {
    responseHeaderTimeoutMs: number;
    idleTimeoutMs: number;
    totalTimeoutMs: number;
    maxResponseBytes: number;
    maxFrameBytes: number;
  };
  private readonly definitions = getPublicModelDefinitions();
  private catalogProjectId?: string;
  private catalogExpiresAt = 0;
  private catalogModelIds = new Set<string>();
  private catalogFailureCode?: string;
  private catalogView: CatalogView;

  constructor(adapterOptions: AntigravityAdapterOptions) {
    super();
    this.adapterOptions = adapterOptions;
    this.transport =
      adapterOptions.transport ??
      createPrivateTransport(
        adapterOptions.responseHeaderTimeoutMs === undefined
          ? {}
          : { responseHeaderTimeoutMs: adapterOptions.responseHeaderTimeoutMs }
      );
    this.options = {
      responseHeaderTimeoutMs: boundedTimeout(
        adapterOptions.responseHeaderTimeoutMs,
        DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS
      ),
      idleTimeoutMs: boundedTimeout(adapterOptions.idleTimeoutMs, DEFAULT_PRIVATE_IDLE_TIMEOUT_MS),
      totalTimeoutMs: boundedTimeout(adapterOptions.totalTimeoutMs, DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS),
      maxResponseBytes: boundedLimit(adapterOptions.maxResponseBytes, DEFAULT_PRIVATE_RESPONSE_BYTES),
      maxFrameBytes: boundedLimit(adapterOptions.maxFrameBytes, DEFAULT_PRIVATE_FRAME_BYTES)
    };
    this.catalogView = createCatalogView(this.definitions, "snapshot");
  }

  public override providerInfo(provider: string) {
    if (provider !== "google-antigravity") {
      throw new LlmError("Unknown Antigravity provider route", "NO_ADAPTER");
    }
    return {
      id: ANTIGRAVITY_PROVIDER,
      name: "Google Antigravity"
    };
  }

  public override providerRetryPolicy() {
    return resolveRetryPolicy(
      {
        mode: "normal",
        maxRetries: 0
      },
      "google-antigravity"
    );
  }

  public invalidateModelCatalog(): void {
    this.catalogProjectId = undefined;
    this.catalogExpiresAt = 0;
    this.catalogModelIds = new Set();
    this.catalogFailureCode = undefined;
    this.catalogView = createCatalogView(this.definitions, "snapshot");
  }

  public catalogSnapshot(): CatalogView {
    return cloneCatalogView(createCatalogView(this.definitions, "snapshot"));
  }

  public async modelCatalog(signal?: AbortSignal, forceRefresh = false): Promise<CatalogView> {
    try {
      const available = await this.readLiveModelIds(signal, forceRefresh);
      this.catalogView = createCatalogView(
        this.definitions,
        "live-available",
        available,
        new Date().toISOString()
      );
    } catch (error) {
      const state =
        error instanceof LlmError && error.code === "PROTOCOL_DRIFT" ? "protocol-drift" : "refresh-failed";
      this.catalogView = createCatalogView(this.definitions, state, undefined, new Date().toISOString());
    }
    return cloneCatalogView(this.catalogView);
  }

  public override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider);
    const snapshot = this.pinnedTextModelInfos();
    let available: Set<string>;
    try {
      available = await this.readLiveModelIds(signal);
      this.catalogView = createCatalogView(
        this.definitions,
        "live-available",
        available,
        new Date().toISOString()
      );
    } catch (error) {
      const state =
        error instanceof LlmError && error.code === "PROTOCOL_DRIFT" ? "protocol-drift" : "refresh-failed";
      this.catalogView = createCatalogView(this.definitions, state, undefined, new Date().toISOString());
      if (!canFallBackToPinnedTextSnapshot(error)) throw error;
      return snapshot;
    }
    return snapshot.filter((model) => available.has(model.id));
  }

  public pinnedTextModelInfos(): LlmModelInfo[] {
    return Object.values(this.definitions)
      .filter((definition) => !definition.modalities.output.includes("image"))
      .map((definition) => ({
        provider: ANTIGRAVITY_PROVIDER,
        id: definition.id,
        name: cleanModelDisplayName(definition.name),
        inputModalities: definition.modalities.input.filter(
          (item): item is "text" | "image" => item === "text" || item === "image"
        )
      }));
  }

  public override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider);
    if (typeof model !== "string" || model.trim().length === 0 || model.length > 256) {
      throw new LlmError("The Antigravity model id is invalid", "INVALID_MODEL");
    }
    const definition = lookupModelDefinition(this.definitions, model);
    if (definition === undefined || definition.modalities.output.includes("image")) {
      throw new LlmError("The Antigravity model is not in the audited text model snapshot", "INVALID_MODEL");
    }
    const reasoning = getModelReasoningEfforts(model);
    return {
      provider: ANTIGRAVITY_PROVIDER,
      id: definition.id,
      name: cleanModelDisplayName(definition.name),
      inputModalities: definition.modalities.input.filter(
        (item): item is "text" | "image" => item === "text" || item === "image"
      ),
      context: { contextWindow: definition.limit.context },
      defaultMaxTokens: definition.limit.output,
      ...reasoning === undefined ? {} : { reasoning }
    };
  }

  public async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, void> {
    if (options.provider !== "google-antigravity") {
      throw new LlmError("The Antigravity adapter received an unknown provider route", "NO_ADAPTER");
    }
    const signal = options.signal;
    const requestedDefinition = lookupModelDefinition(this.definitions, options.model);
    if (requestedDefinition === undefined || requestedDefinition.modalities.output.includes("image")) {
      throw new LlmError("The Antigravity model is not in the audited text model snapshot", "INVALID_MODEL");
    }
    if (isAborted(signal)) {
      yield finishChunk("aborted", "CANCELLED");
      return;
    }

    const hasEmitted = { value: false };
    let replayed = false;
    let networkRetried = false;

    for (;;) {
      const credential = await this.readCredential(signal, replayed);
      if (credential === undefined) {
        throw new LlmError("Antigravity login is required before model use", "AUTH");
      }

      const sessionKey = requestSessionKey(options);
      const requestScope = this.sessions.beginRequest(sessionKey);
      let payload: Record<string, unknown>;
      try {
        payload = await buildAntigravityGeneratePayloadForAdapter(
          options,
          credential,
          requestScope.session,
          requestScope.timestamp,
          this.adapterOptions.attachments
        );
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw toLlmError(error);
      }

      let response: Response;
      try {
        response = await this.transport.request({
          url: ANTIGRAVITY_STREAM_ENDPOINT,
          accessToken: credential.accessToken,
          body: JSON.stringify(payload),
          ...signal === undefined ? {} : { signal },
          responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs
        });
      } catch (error) {
        // Pre-first-byte retry on transient network errors
        if (!hasEmitted.value && !networkRetried && !isAborted(signal)) {
          networkRetried = true;
          continue;
        }
        throw toLlmError(error);
      }

      const statusError = privateStatusError(response.status);
      if (statusError !== undefined) {
        await cancelResponse(response);
        if (statusError.code === "authentication" && !replayed && !hasEmitted.value && !isAborted(signal)) {
          replayed = true;
          continue;
        }
        if (response.status === 400 && (await responseReportsContextWindowExceeded(response, this.options))) {
          throw contextWindowExceededError(response.status);
        }
        throw toLlmError(statusError);
      }

      try {
        yield* this.streamResponse(response, options, hasEmitted);
        return;
      } catch (error) {
        if (
          (error instanceof PrivateTransportError ? error : undefined)?.code === "authentication" &&
          !replayed &&
          !hasEmitted.value &&
          !isAborted(signal)
        ) {
          replayed = true;
          continue;
        }
        throw toLlmError(error);
      }
    }
  }

  private async *streamResponse(
    response: Response,
    options: GenerateOptions,
    hasEmitted: { value: boolean }
  ): AsyncGenerator<StreamChunk, void, void> {
    const states: BlockState[] = [];
    let current: BlockState | undefined;
    let usage: TokenUsage | undefined;
    let finish: string | undefined;
    let eventError: { status?: number; code?: string; contextWindowExceeded?: boolean } | undefined;

    for await (const sse of iteratePrivateSse(response, {
      ...options.signal === undefined ? {} : { signal: options.signal },
      idleTimeoutMs: this.options.idleTimeoutMs,
      totalTimeoutMs: this.options.totalTimeoutMs,
      maxBytes: this.options.maxResponseBytes,
      maxFrameBytes: this.options.maxFrameBytes
    })) {
      if (sse.data.trim() === "[DONE]") continue;
      const event = parseProviderEvent(sse.data);
      if (event.error !== undefined) {
        eventError = event.error;
        if (event.error.status === 401 || isAuthenticationCode(event.error.code)) {
          throw new PrivateTransportError("authentication", "The private endpoint requires authentication", {
            status: event.error.status ?? 401
          });
        }
        break;
      }
      if (event.usage !== undefined) usage = event.usage;
      if (event.finish !== undefined) finish = event.finish;

      for (const part of event.parts) {
        if (current === undefined || !sameBlock(current, part)) {
          if (current !== undefined) yield endBlock(current);
          current = beginBlock(states, part);
          yield {
            type: "block-start",
            index: current.index,
            blockType: current.kind
          };
        }

        if (part.kind === "tool-call") {
          if (part.name !== undefined) {
            current.name = assembleFunctionName(current.name, part.name);
          }
          current.text += part.arguments;
          hasEmitted.value = hasEmitted.value || part.arguments.length > 0 || part.name !== undefined;
          yield {
            type: "tool-call-delta",
            index: current.index,
            id: current.id,
            ...part.name === undefined ? {} : { name: part.name },
            argumentsDelta: part.arguments
          };
          if (part.signature !== undefined) current.signature = part.signature;
        } else if (part.kind === "reasoning") {
          current.text += part.text;
          hasEmitted.value = hasEmitted.value || part.text.length > 0;
          if (part.text.length > 0) {
            yield {
              type: "reasoning-delta",
              index: current.index,
              text: part.text
            };
          }
        } else {
          current.text += part.text;
          hasEmitted.value = hasEmitted.value || part.text.length > 0;
          if (part.text.length > 0) {
            yield {
              type: "text-delta",
              index: current.index,
              text: part.text
            };
          }
        }
      }
    }

    if (current !== undefined) yield endBlock(current);
    if (usage !== undefined) {
      yield {
        type: "usage",
        usage
      };
    }
    if (eventError !== undefined) {
      yield finishChunk(
        "error",
        eventError.contextWindowExceeded === true ? CONTEXT_WINDOW_EXCEEDED_CODE : safeProviderErrorCode(eventError.code),
        safeProviderStatus(eventError.status)
      );
      return;
    }
    if (isAborted(options.signal)) {
      yield finishChunk("aborted", "CANCELLED");
      return;
    }
    if (states.length === 0) {
      yield finishChunk("error", "EMPTY_RESPONSE");
      return;
    }

    const replayBlocks = states.map((state) => ({
      kind: state.kind,
      ...state.signature === undefined ? {} : { signature: state.signature }
    }));
    const replayState = createReplayState(
      options.model,
      antigravityModelFamily(options.model),
      finish,
      replayBlocks
    );
    yield finishChunk(mapFinishReason(finish), finish ?? "STOP", undefined, replayState);
  }

  private async readLiveModelIds(
    signal?: AbortSignal,
    bypassCache = false,
    forceCredentialRefresh = false
  ): Promise<Set<string>> {
    const credential = await this.readCredential(signal, forceCredentialRefresh);
    if (credential === undefined) {
      throw new LlmError("Antigravity login is required before model discovery", "AUTH");
    }
    if (!bypassCache && this.catalogProjectId === credential.projectId && Date.now() < this.catalogExpiresAt) {
      if (this.catalogFailureCode !== undefined) {
        throw new LlmError("The Antigravity live model catalog refresh remains unavailable", this.catalogFailureCode);
      }
      return this.catalogModelIds;
    }

    let response: Response;
    const body = credential.projectId ? { project: credential.projectId } : {};
    try {
      response = await this.transport.request({
        url: ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT,
        accessToken: credential.accessToken,
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
        responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs
      });
    } catch (error) {
      const failure = toModelCatalogError(error, signal, "provider");
      this.rememberCatalogFailure(credential.projectId, failure);
      throw failure;
    }

    if (response.status === 403 && credential.projectId) {
      try {
        const retryResponse = await this.transport.request({
          url: ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT,
          accessToken: credential.accessToken,
          body: JSON.stringify({}),
          ...signal === undefined ? {} : { signal },
          responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs
        });
        if (retryResponse.ok) {
          await cancelResponse(response);
          response = retryResponse;
        } else {
          await cancelResponse(retryResponse);
        }
      } catch (error) {
        const failure = toModelCatalogError(error, signal, "provider");
        if (failure.code === "CANCELLED" || failure.code === "GATE_0_ATTRIBUTION") {
          await cancelResponse(response);
          this.rememberCatalogFailure(credential.projectId, failure);
          throw failure;
        }
      }
    }

    const statusError = privateStatusError(response.status);
    if (statusError !== undefined) {
      await cancelResponse(response);
      if (statusError.code === "authentication" && !forceCredentialRefresh && !isAborted(signal)) {
        this.catalogExpiresAt = 0;
        return this.readLiveModelIds(signal, true, true);
      }
      const failure = toLlmError(statusError);
      this.rememberCatalogFailure(credential.projectId, failure);
      throw failure;
    }

    let value: unknown;
    try {
      value = JSON.parse(
        await readPrivateText(response, {
          ...signal === undefined ? {} : { signal },
          idleTimeoutMs: this.options.idleTimeoutMs,
          totalTimeoutMs: this.options.totalTimeoutMs,
          maxBytes: Math.min(this.options.maxResponseBytes, MAX_MODEL_CATALOG_BYTES)
        })
      );
    } catch (error) {
      const failure = toModelCatalogError(error, signal, "protocol");
      this.rememberCatalogFailure(credential.projectId, failure);
      throw failure;
    }

    let ids: Set<string>;
    try {
      ids = parseLiveModelIds(value, this.definitions);
    } catch (error) {
      const failure =
        error instanceof LlmError
          ? error
          : new LlmError("The Antigravity live model catalog did not match the audited schema", "PROTOCOL_DRIFT");
      this.rememberCatalogFailure(credential.projectId, failure);
      throw failure;
    }

    this.catalogProjectId = credential.projectId;
    this.catalogModelIds = ids;
    this.catalogFailureCode = undefined;
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS;
    return ids;
  }

  private rememberCatalogFailure(projectId: string | undefined, failure: LlmError): void {
    if (failure.code === "AUTH" || failure.code === "CANCELLED") return;
    this.catalogProjectId = projectId;
    this.catalogModelIds = new Set();
    this.catalogFailureCode = failure.code;
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS;
  }

  private async readCredential(signal?: AbortSignal, forceRefresh = false) {
    try {
      return await this.adapterOptions.auth.credential(signal, forceRefresh ? { forceRefresh: true } : undefined);
    } catch (error) {
      throw toLlmError(error);
    }
  }
}

function beginBlock(states: BlockState[], part: ProviderPart): BlockState {
  const index = states.length;
  const block: BlockState =
    part.kind === "tool-call"
      ? {
          index,
          kind: "tool-call",
          id: ToolCallId(part.id ?? `antigravity-call-${String(index)}`),
          ...part.name === undefined ? {} : { name: part.name },
          text: "",
          ...part.signature === undefined ? {} : { signature: part.signature }
        }
      : {
          index,
          kind: part.kind,
          id: ToolCallId(`antigravity-block-${String(index)}`),
          text: "",
          ...part.signature === undefined ? {} : { signature: part.signature }
        };
  states.push(block);
  return block;
}

function sameBlock(state: BlockState, part: ProviderPart): boolean {
  if (state.kind !== part.kind) return false;
  return part.kind !== "tool-call" || part.id === undefined || part.id === String(state.id);
}

function assembleFunctionName(current: string | undefined, fragment: string): string {
  if (fragment.length === 0 || fragment.length > 256 || containsControl(fragment)) {
    throw new PrivateTransportError("protocol-drift", "The private tool-call name was invalid");
  }
  if (current === undefined || current.length === 0) return fragment;
  if (fragment === current) return current;
  if (fragment.startsWith(current)) return fragment;
  const combined = `${current}${fragment}`;
  if (combined.length > 256) {
    throw new PrivateTransportError("protocol-drift", "The private tool-call name exceeded the byte limit");
  }
  return combined;
}

function endBlock(state: BlockState): StreamChunk {
  if (state.kind === "text") {
    return {
      type: "block-end",
      index: state.index,
      block: {
        type: "text",
        text: state.text
      }
    };
  }
  if (state.kind === "reasoning") {
    return {
      type: "block-end",
      index: state.index,
      block: {
        type: "reasoning",
        text: state.text
      }
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.text);
  } catch {
    throw new PrivateTransportError("protocol-drift", "The private tool-call arguments were incomplete JSON");
  }
  if (!isRecord(parsed)) {
    throw new PrivateTransportError("protocol-drift", "The private tool-call arguments were not an object");
  }
  const args = state.text;
  if (state.name === undefined || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u.test(state.name)) {
    throw new PrivateTransportError("protocol-drift", "The private tool-call name was missing or invalid");
  }
  return {
    type: "block-end",
    index: state.index,
    block: {
      type: "tool-call",
      id: state.id,
      name: state.name,
      arguments: args
    }
  };
}

export function buildAntigravityGeneratePayload(options: GenerateOptions, credential: AntigravityCredential) {
  const toolNames = new Map<string, string>();
  return buildPayloadFromContents(
    options,
    credential,
    options.messages
      .filter((message) => message.role !== "system")
      .map((message) => mapMessage(message, options.model, toolNames))
  );
}

export async function buildAntigravityGeneratePayloadForAdapter(
  options: GenerateOptions,
  credential: AntigravityCredential,
  session: AgyRequestSessionContext,
  timestamp: number,
  attachments?: AntigravityAttachmentStore
): Promise<Record<string, unknown>> {
  const contents = [];
  const toolNames = new Map<string, string>();
  for (const message of options.messages) {
    if (message.role === "system") continue;
    contents.push(
      await mapMessageWithAttachments(message, options.model, toolNames, attachments, options.signal)
    );
  }
  const payload = buildPayloadFromContents(options, credential, contents);
  const metadata = buildAgyAgentRequestMetadata(
    session,
    payload.request as Record<string, unknown>,
    resolveWireModel(options.model, options.reasoningEffort),
    timestamp
  );
  const request = payload.request as Record<string, unknown>;
  request.labels = metadata.labels;
  request.sessionId = metadata.sessionId;
  orderAgyRequestPayloadInPlace(request);
  return {
    ...payload.project === undefined ? {} : { project: payload.project },
    requestId: metadata.requestId,
    request,
    model: payload.model,
    userAgent: "antigravity",
    requestType: "agent"
  };
}

function buildPayloadFromContents(
  options: GenerateOptions,
  credential: AntigravityCredential,
  contents: Array<{ role: string; parts: unknown[] }>
) {
  const wireModel = resolveWireModel(options.model, options.reasoningEffort);
  const usesCapturedGemini38ThinkingBudget = /^gemini-3\.8-flash-(?:low|medium|high)$/u.test(wireModel);
  const request: Record<string, unknown> = { contents: groupClaudeFunctionResponses(contents, options.model) };
  const systemParts: Array<{ text: string }> = [
    ...options.system?.trim() ? [{ text: options.system }] : [],
    ...options.messages.flatMap((message: Message) =>
      message.role === "system"
        ? message.content.flatMap((block) => (block.type === "text" && block.text.trim() ? [{ text: block.text }] : []))
        : []
    )
  ];
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts };

  const generationConfig: Record<string, unknown> = {};
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = boundedInteger(options.maxTokens, 1, 1_000_000, "maxTokens");
  } else if (usesCapturedGemini38ThinkingBudget) {
    generationConfig.maxOutputTokens = 65536;
  }
  if (options.temperature !== undefined) {
    generationConfig.temperature = boundedNumber(options.temperature, -100, 100, "temperature");
  }
  if (options.stop !== undefined) {
    generationConfig.stopSequences = options.stop.slice(0, 16).map((item: string) => item.slice(0, 256));
  }
  if (options.reasoningEffort !== undefined) {
    generationConfig.thinkingConfig = { thinkingLevel: String(options.reasoningEffort) };
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

  if (options.tools !== undefined && options.tools.length > 0) {
    const declarations = buildFunctionDeclarations(options.tools);
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }];
  }

  const resolved = resolveModelWithTier(usesCapturedGemini38ThinkingBudget ? wireModel : options.model, {
    cli_first: false
  });
  const thinkingTier: ThinkingTier | undefined = normalizeReasoningEffort(options.reasoningEffort);

  if (wireModel.toLowerCase().includes("claude")) {
    applyClaudeToolHardening(request);
    applyClaudeTransforms(request, {
      model: wireModel,
      ...resolved.thinkingBudget === undefined ? {} : { tierThinkingBudget: resolved.thinkingBudget },
      ...options.reasoningEffort === undefined && resolved.thinkingBudget === undefined
        ? {}
        : {
            normalizedThinking: {
              includeThoughts: true,
              ...resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }
            }
          },
      cleanJSONSchema: (value) => (isRecord(value) ? value : { type: "object", properties: {} })
    });
  } else {
    applyGeminiTransforms(request, {
      model: wireModel,
      ...thinkingTier === undefined || usesCapturedGemini38ThinkingBudget ? {} : { tierThinkingLevel: thinkingTier },
      ...resolved.thinkingBudget === undefined ? {} : { tierThinkingBudget: resolved.thinkingBudget },
      ...options.reasoningEffort === undefined && resolved.thinkingBudget === undefined
        ? {}
        : {
            normalizedThinking: {
              includeThoughts: true,
              ...resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }
            }
          }
    });
    if (usesCapturedGemini38ThinkingBudget) {
      const transformedConfig = request.generationConfig;
      if (!isRecord(transformedConfig) || typeof resolved.thinkingBudget !== "number") {
        throw new LlmError("The Gemini 3.8 captured thinking configuration could not be resolved", "PROTOCOL_DRIFT");
      }
      transformedConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: resolved.thinkingBudget
      };
    }
  }

  const project =
    credential.projectId === "inductive-dreamer-qrkws" || !credential.projectId ? undefined : credential.projectId;
  return {
    ...project === undefined ? {} : { project },
    model: wireModel,
    request
  };
}

function mapMessage(message: Message, model: string, toolNames: Map<string, string>) {
  const parts: unknown[] = [];
  const replayBlocks = compatibleReplayState(message, "google-antigravity", model, contentKinds(message))?.blocks ?? [];
  const isClaude = antigravityModelFamily(model) === "claude";
  let replayIndex = 0;
  let sawClaudeFunctionCall = false;

  for (const block of message.content) {
    const replayKind =
      block.type === "text" || block.type === "reasoning" || block.type === "tool-call" ? block.type : undefined;
    const replayBlock = replayKind === undefined ? undefined : replayBlocks[replayIndex++];
    const replaySignature =
      replayBlock !== undefined && replayBlock.kind === replayKind ? replayBlock.signature : undefined;
    const blockSignature = (block as { signature?: string; thoughtSignature?: string }).signature ??
      (block as { thoughtSignature?: string }).thoughtSignature ??
      replaySignature;

    if (block.type === "text") {
      if (block.text.length === 0 && message.content.length > 1) continue;
      parts.push({
        text: block.text,
        ...blockSignature === undefined ? {} : { thoughtSignature: blockSignature }
      });
    } else if (block.type === "reasoning") {
      if (isClaude && blockSignature === undefined) continue;
      parts.push({
        text: block.text,
        thought: true,
        ...blockSignature === undefined ? {} : { thoughtSignature: blockSignature }
      });
    } else if (block.type === "tool-call") {
      const callId = rememberToolName(toolNames, block.id, block.name);
      const signature = isClaude
        ? sawClaudeFunctionCall
          ? undefined
          : blockSignature ?? SKIP_THOUGHT_SIGNATURE
        : blockSignature;
      sawClaudeFunctionCall = sawClaudeFunctionCall || isClaude;
      parts.push({
        functionCall: {
          ...isClaude ? { id: callId } : {},
          name: block.name,
          args: parseJsonObject(block.arguments)
        },
        ...signature === undefined ? {} : { thoughtSignature: signature }
      });
    } else if (block.type === "tool-result") {
      const callId = requireToolCallId(block.toolCallId);
      parts.push({
        functionResponse: {
          ...isClaude ? { id: callId } : {},
          name: requireToolName(toolNames, callId),
          response: { content: blocksToText(block.content) }
        }
      });
    } else if (block.type === "image") {
      throw new LlmError("Antigravity text requests do not accept unresolved image blocks", "UNSUPPORTED_MODALITY");
    }
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts
  };
}

async function mapMessageWithAttachments(
  message: Message,
  model: string,
  toolNames: Map<string, string>,
  attachments?: AntigravityAttachmentStore,
  signal?: AbortSignal
) {
  if (!message.content.some((block) => block.type === "image")) {
    return mapMessage(message, model, toolNames);
  }
  if (attachments === undefined) {
    throw new LlmError("Antigravity image input requires the Host AttachmentStore", "UNSUPPORTED_MODALITY");
  }
  const replayBlocks = compatibleReplayState(message, "google-antigravity", model, contentKinds(message))?.blocks ?? [];
  const parts: unknown[] = [];
  const isClaude = antigravityModelFamily(model) === "claude";
  let replayIndex = 0;
  let sawClaudeFunctionCall = false;

  for (const block of message.content) {
    const replayKind =
      block.type === "text" || block.type === "reasoning" || block.type === "tool-call" ? block.type : undefined;
    const replayBlock = replayKind === undefined ? undefined : replayBlocks[replayIndex++];
    const replaySignature =
      replayBlock !== undefined && replayBlock.kind === replayKind ? replayBlock.signature : undefined;
    const blockSignature = (block as { signature?: string; thoughtSignature?: string }).signature ??
      (block as { thoughtSignature?: string }).thoughtSignature ??
      replaySignature;

    if (block.type === "image") {
      const stored = await attachments.readImage(block.attachment, signal);
      parts.push({
        inlineData: {
          mimeType: stored.ref.mediaType,
          data: Buffer.from(stored.data).toString("base64")
        }
      });
    } else if (block.type === "text") {
      if (block.text.length === 0 && message.content.length > 1) continue;
      parts.push({
        text: block.text,
        ...blockSignature === undefined ? {} : { thoughtSignature: blockSignature }
      });
    } else if (block.type === "reasoning") {
      if (isClaude && blockSignature === undefined) continue;
      parts.push({
        text: block.text,
        thought: true,
        ...blockSignature === undefined ? {} : { thoughtSignature: blockSignature }
      });
    } else if (block.type === "tool-call") {
      const callId = rememberToolName(toolNames, block.id, block.name);
      const signature = isClaude
        ? sawClaudeFunctionCall
          ? undefined
          : blockSignature ?? SKIP_THOUGHT_SIGNATURE
        : blockSignature;
      sawClaudeFunctionCall = sawClaudeFunctionCall || isClaude;
      parts.push({
        functionCall: {
          ...isClaude ? { id: callId } : {},
          name: block.name,
          args: parseJsonObject(block.arguments)
        },
        ...signature === undefined ? {} : { thoughtSignature: signature }
      });
    } else if (block.type === "tool-result") {
      const callId = requireToolCallId(block.toolCallId);
      parts.push({
        functionResponse: {
          ...isClaude ? { id: callId } : {},
          name: requireToolName(toolNames, callId),
          response: { content: blocksToText(block.content) }
        }
      });
    }
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts
  };
}

function rememberToolName(toolNames: Map<string, string>, callId: unknown, name: string): string {
  if (name.length === 0 || name.length > 256 || containsControl(name)) {
    throw new LlmError("The tool call name is invalid", "INVALID_ARGS");
  }
  const id = requireToolCallId(callId);
  const existing = toolNames.get(id);
  if (existing !== undefined && existing !== name) {
    throw new LlmError("A tool call id was reused with a different name", "INVALID_ARGS");
  }
  toolNames.set(id, name);
  return id;
}

function requireToolName(toolNames: Map<string, string>, callId: string): string {
  const existing = toolNames.get(callId);
  if (existing === undefined) {
    throw new LlmError("The tool response did not match a known tool call", "INVALID_ARGS");
  }
  return existing;
}

function requireToolCallId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || containsControl(value)) {
    throw new LlmError("The tool call id is invalid", "INVALID_ARGS");
  }
  return value;
}

function requestSessionKey(options: GenerateOptions): string {
  return options.sessionId === undefined ? "default" : `session:${fnv1a64Signed(String(options.sessionId))}`;
}

function contentKinds(message: Message): string[] {
  return message.content.flatMap((block) =>
    block.type === "text" || block.type === "reasoning" || block.type === "tool-call" ? [block.type] : []
  );
}

function parseProviderEvent(data: string): ProviderEvent {
  const normalized = data.trim().replace(/^\)\]\}'(?:\r?\n)?/u, "");
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new PrivateTransportError("invalid-response", "The private response contained invalid JSON");
  }
  if (!isRecord(value)) {
    throw new PrivateTransportError("protocol-drift", "The private response event was not an object");
  }
  if (isRecord(value.error)) {
    return {
      parts: [],
      error: errorDetails(value.error)
    };
  }
  const root = isRecord(value.response) ? value.response : value;
  if (isRecord(root.error)) {
    return {
      parts: [],
      error: errorDetails(root.error)
    };
  }
  const partsValue = findParts(root);
  const parts: ProviderPart[] = [];
  for (const part of partsValue) {
    const parsed = parsePart(part);
    if (parsed !== undefined) parts.push(parsed);
  }
  const usage = parseUsage(root.usageMetadata ?? value.usageMetadata);
  const finish = findFinish(root);
  return {
    parts,
    ...usage === undefined ? {} : { usage },
    ...finish === undefined ? {} : { finish }
  };
}

function findParts(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.parts)) return boundedParts(value.parts);
  if (Array.isArray(value.candidates)) {
    for (const candidate of value.candidates) {
      if (isRecord(candidate) && isRecord(candidate.content) && Array.isArray(candidate.content.parts)) {
        return boundedParts(candidate.content.parts);
      }
    }
  }
  return [];
}

function boundedParts(parts: unknown[]): unknown[] {
  if (parts.length > MAX_PROVIDER_PARTS) {
    throw new PrivateTransportError("protocol-drift", "The private response contained too many parts");
  }
  return parts;
}

function parsePart(value: unknown): ProviderPart | undefined {
  if (!isRecord(value)) {
    throw new PrivateTransportError("protocol-drift", "The private response part was not an object");
  }
  const functionCall = isRecord(value.functionCall) ? value.functionCall : undefined;
  if (functionCall !== undefined) {
    const name = stringValue(functionCall.name);
    const args = isRecord(functionCall.args) ? JSON.stringify(functionCall.args) : "";
    return {
      kind: "tool-call",
      ...name === undefined ? {} : { name },
      arguments: args,
      ...functionCall.id === undefined ? {} : { id: stringValue(functionCall.id) },
      ...signatureOf(value) === undefined ? {} : { signature: signatureOf(value) }
    };
  }
  if (typeof value.text === "string" || signatureOf(value) !== undefined) {
    const kind = value.thought === true || value.reasoning === true || value.thinking === true ? "reasoning" : "text";
    const signature = signatureOf(value);
    return {
      kind,
      text: typeof value.text === "string" ? value.text : "",
      ...signature === undefined ? {} : { signature }
    };
  }
  if (value.inlineData !== undefined || value.inline_data !== undefined) {
    throw new PrivateTransportError("protocol-drift", "The text model returned unsupported media output");
  }
  throw new PrivateTransportError("protocol-drift", "The private response contained an unknown part type");
}

function errorDetails(value: Record<string, unknown>) {
  const status = numberValue(value.status);
  const code = stringValue(value.code);
  return {
    ...status === undefined ? {} : { status },
    ...code === undefined ? {} : { code }
  };
}

async function responseReportsContextWindowExceeded(
  response: Response,
  options: { idleTimeoutMs: number; totalTimeoutMs: number; maxResponseBytes: number; maxFrameBytes: number }
): Promise<boolean> {
  try {
    for await (const event of iteratePrivateSse(response, {
      idleTimeoutMs: options.idleTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      maxBytes: Math.min(MAX_PROVIDER_ERROR_BYTES, options.maxResponseBytes),
      maxFrameBytes: Math.min(MAX_PROVIDER_ERROR_FRAME_BYTES, options.maxFrameBytes)
    })) {
      if (providerErrorEnvelopeReportsContextWindowExceeded(event.data.replace(/^\)\]\}'(?:\r?\n)?/u, ""), 0)) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if (error instanceof PrivateTransportError && error.code === "cancelled") throw toLlmError(error);
    return false;
  }
}

function providerErrorEnvelopeReportsContextWindowExceeded(value: string, depth: number): boolean {
  if (depth > MAX_PROVIDER_ERROR_JSON_DEPTH || value.length === 0 || value.length > MAX_PROVIDER_ERROR_BYTES) {
    return false;
  }
  const json = value.trim();
  if (!json.startsWith("{") || !jsonDepthIsBounded(json, MAX_PROVIDER_ERROR_JSON_DEPTH)) return false;
  try {
    const parsed = JSON.parse(json);
    return isRecord(parsed) && isRecord(parsed.error) ? providerErrorReportsContextWindowExceeded(parsed.error, depth + 1) : false;
  } catch {
    return false;
  }
}

function providerErrorReportsContextWindowExceeded(value: unknown, depth: number): boolean {
  if (depth > MAX_PROVIDER_ERROR_JSON_DEPTH || !isRecord(value)) return false;
  if (typeof value.message === "string") {
    if (isExactContextWindowExceededMessage(value.message)) return true;
    if (providerErrorEnvelopeReportsContextWindowExceeded(value.message, depth + 1)) return true;
  }
  return isRecord(value.error) && providerErrorReportsContextWindowExceeded(value.error, depth + 1);
}

function isExactContextWindowExceededMessage(value: string): boolean {
  const match = /^prompt is too long: ([0-9]{1,16}) tokens > ([0-9]{1,16}) maximum$/u.exec(value);
  const actual = match?.[1];
  const maximum = match?.[2];
  return actual !== undefined && maximum !== undefined && BigInt(actual) > BigInt(maximum);
}

function jsonDepthIsBounded(value: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maxDepth) return false;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString && !escaped;
}

function contextWindowExceededError(status?: number): LlmError {
  const message = "The Antigravity request exceeded the model context window";
  return status === undefined
    ? new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
    : new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, { status });
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = numberValue(value.promptTokenCount ?? value.inputTokenCount);
  const output = numberValue(value.candidatesTokenCount ?? value.outputTokenCount);
  const reasoning = numberValue(value.thoughtsTokenCount ?? value.reasoningTokenCount);
  const cached = numberValue(value.cachedContentTokenCount ?? value.cacheReadTokens);
  if (input === undefined && output === undefined && reasoning === undefined && cached === undefined) {
    return undefined;
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...cached === undefined ? {} : { cacheReadTokens: cached },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning }
  };
}

function findFinish(value: Record<string, unknown>): string | undefined {
  const candidate = value.finishReason ?? value.finish_reason;
  if (typeof candidate === "string") return candidate;
  if (isRecord(value.serverContent) && typeof value.serverContent.finishReason === "string") {
    return value.serverContent.finishReason;
  }
  if (Array.isArray(value.candidates)) {
    for (const item of value.candidates) {
      if (isRecord(item) && typeof item.finishReason === "string") return item.finishReason;
    }
  }
  return undefined;
}

function signatureOf(value: Record<string, unknown>): string | undefined {
  return stringValue(value.thoughtSignature ?? value.thought_signature ?? value.signature);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {}
  throw new LlmError("The Antigravity tool-call history is malformed", "PROTOCOL_DRIFT");
}

function blocksToText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .slice(0, 65536);
}

function isAuthenticationCode(value?: string): boolean {
  const normalized = value?.toUpperCase();
  return (
    normalized === "UNAUTHENTICATED" ||
    normalized === "AUTHENTICATION" ||
    normalized === "INVALID_GRANT" ||
    normalized === "UNAUTHENTICATED_REQUEST"
  );
}

function mapFinishReason(value?: string): "stop" | "max-tokens" | "tool-calls" | "error" {
  const normalized = value?.toUpperCase();
  if (normalized === "MAX_TOKENS" || normalized === "LENGTH") return "max-tokens";
  if (normalized === "SAFETY" || normalized === "BLOCKLIST" || normalized === "ERROR") return "error";
  if (normalized === "TOOL_CALLS" || normalized === "FUNCTION_CALL") return "tool-calls";
  return "stop";
}

function finishChunk(kind: string, code?: string, status?: number, replayState?: ReplayEnvelope): StreamChunk {
  return {
    type: "finish",
    reason:
      kind === "aborted"
        ? {
            kind: "aborted",
            failure: {
              code: code ?? "CANCELLED",
              message: "The Antigravity request was cancelled"
            }
          }
        : kind === "error"
          ? {
              kind: "error",
              failure: {
                code: code ?? "PROVIDER_ERROR",
                message: "The Antigravity provider request failed",
                ...status === undefined ? {} : { status }
              }
            }
          : kind === "max-tokens"
            ? { kind: "max-tokens" }
            : kind === "tool-calls"
              ? { kind: "tool-calls" }
              : { kind: "stop" },
    ...replayState === undefined ? {} : { replayState }
  };
}

const LLM_FAILURE_CODES: Record<string, string> = {
  authentication: "AUTH",
  forbidden: "FORBIDDEN",
  "rate-limited": "RATE_LIMIT",
  cancelled: "CANCELLED",
  timeout: "TIMEOUT",
  "attribution-rejected": "GATE_0_ATTRIBUTION",
  "protocol-drift": "PROTOCOL_DRIFT",
  "response-limit": "RESPONSE_LIMIT",
  "request-limit": "REQUEST_LIMIT",
  upstream: "UPSTREAM",
  network: "NETWORK",
  failed: "PROVIDER_ERROR"
};

function canFallBackToPinnedTextSnapshot(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;
  return (
    error.code === "RATE_LIMIT" ||
    error.code === "TIMEOUT" ||
    error.code === "PROTOCOL_DRIFT" ||
    error.code === "RESPONSE_LIMIT" ||
    error.code === "UPSTREAM" ||
    error.code === "NETWORK"
  );
}

function toModelCatalogError(error: unknown, signal?: AbortSignal, fallback?: "provider" | "protocol"): LlmError {
  if (isAborted(signal)) return new LlmError("The Antigravity live model catalog request was cancelled", "CANCELLED");
  if (error instanceof LlmError) return error;
  if (error instanceof PrivateTransportError || fallback === "provider") return toLlmError(error);
  return new LlmError("The Antigravity live model catalog did not match the audited schema", "PROTOCOL_DRIFT");
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof PrivateTransportError) {
    const kind = classifyPrivateFailure(error);
    const code = LLM_FAILURE_CODES[kind] ?? "PROVIDER_ERROR";
    const message =
      kind === "rate-limited"
        ? "Antigravity rate limit reached (Google returned 429 Resource Exhausted); please wait for your quota window to refresh"
        : "The Antigravity private request failed safely";
    return error.status === undefined ? new LlmError(message, code) : new LlmError(message, code, { status: error.status });
  }
  return new LlmError("The Antigravity provider request failed safely", "PROVIDER_ERROR");
}

function boundedTimeout(value: unknown, fallback: number): number {
  return typeof value !== "number" || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.min(Math.floor(value), 600_000);
}

function boundedLimit(value: unknown, fallback: number): number {
  return typeof value !== "number" || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.min(Math.floor(value), fallback);
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LlmError(`The Antigravity ${field} option is invalid`, "INVALID_OPTIONS");
  }
  return value;
}

function boundedNumber(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new LlmError(`The Antigravity ${field} option is invalid`, "INVALID_OPTIONS");
  }
  return value;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 16384 && !containsControl(value)
    ? value
    : undefined;
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function safeProviderErrorCode(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !containsControl(value)
    ? value
    : "PROVIDER_ERROR";
}

function safeProviderStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}
