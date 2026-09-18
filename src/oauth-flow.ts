import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES
} from "@cortexkit/antigravity-auth-core";
import { isBoundedSafeText } from "./safe-text.js";
import { normalizeProjectId, ProjectDiscoveryError } from "./project-context.js";

export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_CALLBACK_HOSTS = Object.freeze([
  `localhost:${String(ANTIGRAVITY_CALLBACK_PORT)}`,
  `127.0.0.1:${String(ANTIGRAVITY_CALLBACK_PORT)}`,
  `[::1]:${String(ANTIGRAVITY_CALLBACK_PORT)}`,
  "localhost",
  "127.0.0.1",
  "[::1]"
]);

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MAX_CALLBACK_VALUE_LENGTH = 4096;
const MAX_TOKEN_RESPONSE_BYTES = 65_536;

const EMPTY_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
});

export type OAuthPhase = "idle" | "pending" | "success" | "cancelled" | "expired" | "port-conflict" | "failed";

export class OAuthFlowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OAuthFlowError";
    this.code = code;
  }
}

export interface ExchangedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
}

export interface ValidatedProject {
  projectId: string;
  email?: string;
}

export interface OAuthFlowStatus {
  phase: OAuthPhase;
  authorizationUrl?: string;
  expiresAt?: string;
  errorCode?: string;
}

export interface OAuthFlowResult {
  started?: boolean;
  completed?: boolean;
  phase: OAuthPhase;
  authorizationUrl?: string;
  expiresAt?: string;
  errorCode?: string;
}

export interface LoopbackRequest {
  method: string;
  host?: string;
  url: string;
}

export interface LoopbackResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface LoopbackListener {
  close: () => Promise<void>;
}

export interface LoopbackListenerFactory {
  listen: (handler: (request: LoopbackRequest) => Promise<LoopbackResponse>) => Promise<LoopbackListener>;
}

export interface OAuthFlowOptions {
  ttlMs?: number;
  listenerFactory?: LoopbackListenerFactory;
  fetchImpl?: typeof globalThis.fetch;
  validateProject?: (accessToken: string, signal?: AbortSignal) => Promise<ValidatedProject | undefined>;
  commit?: (token: ExchangedToken, project: ValidatedProject, signal?: AbortSignal) => Promise<void>;
}

interface PendingCandidate {
  authorizationUrl: string;
  expiresAt: number;
  state: string;
  verifier: string;
  controller: AbortController;
  generation: number;
  timeout: NodeJS.Timeout;
  active: boolean;
  commitStarted: boolean;
  listener?: LoopbackListener;
}

export interface OAuthFlow {
  generation: () => number;
  start: () => Promise<OAuthFlowResult>;
  status: () => OAuthFlowStatus;
  completeCallbackUrl: (callbackUrl: string) => Promise<OAuthFlowResult>;
  cancel: () => Promise<OAuthFlowStatus>;
  dispose: () => Promise<void>;
}

export function createOAuthFlow(options: OAuthFlowOptions = {}): OAuthFlow {
  const listenerFactory = options.listenerFactory ?? createNodeLoopbackListenerFactory();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const validateProject = options.validateProject ?? (async () => undefined);
  const commit = options.commit ?? (async () => {});
  const ttlMs = options.ttlMs ?? 300_000;

  let pending: PendingCandidate | undefined;
  let processing: PendingCandidate | undefined;
  let generation = 0;
  let committingGeneration: number | undefined;
  let currentStatus: OAuthFlowStatus = { phase: "idle" };
  let disposed = false;
  let listenerClosing: Promise<void> = Promise.resolve();

  const closeListener = (candidate: PendingCandidate): Promise<void> => {
    const listener = candidate.listener;
    candidate.listener = undefined;
    if (!listener) return listenerClosing;
    listenerClosing = listenerClosing
      .then(() => listener.close().catch(() => {}))
      .then(() => {});
    return listenerClosing;
  };

  const updateStatus = (candidate: PendingCandidate, status: OAuthFlowStatus) => {
    if (candidate.generation === generation) currentStatus = status;
  };

  const cancelPending = async (candidate: PendingCandidate, phase: "cancelled" | "expired") => {
    if (!candidate.active && pending !== candidate) return;
    candidate.active = false;
    if (pending === candidate) pending = undefined;
    clearTimeout(candidate.timeout);
    candidate.controller.abort(
      new OAuthFlowError(phase, phase === "expired" ? "The OAuth login expired" : "The OAuth login was cancelled")
    );
    await closeListener(candidate);
    updateStatus(candidate, { phase, errorCode: phase });
  };

  const completeCallback = async (request: LoopbackRequest): Promise<OAuthFlowResult> => {
    if (disposed) throw new OAuthFlowError("internal", "The OAuth flow is unavailable");
    const candidate = pending;
    if (!candidate?.active) throw noPendingError(currentStatus);

    assertCallbackRequest(request);
    const callback = parseCallback(request.url);
    if (callback.state !== candidate.state) {
      throw new OAuthFlowError("state-mismatch", "The OAuth callback state was not accepted");
    }

    candidate.active = false;
    pending = undefined;
    processing = candidate;
    clearTimeout(candidate.timeout);
    await closeListener(candidate);

    if (callback.error) {
      processing = undefined;
      candidate.controller.abort(new OAuthFlowError("oauth-error", "The OAuth provider rejected authorization"));
      updateStatus(candidate, { phase: "failed", errorCode: "oauth-error" });
      return { completed: false, phase: "failed", errorCode: "oauth-error" };
    }

    if (!callback.code) {
      processing = undefined;
      updateStatus(candidate, { phase: "failed", errorCode: "missing-code" });
      return { completed: false, phase: "failed", errorCode: "missing-code" };
    }

    try {
      const token = await exchangeGoogleCode(callback.code, candidate.verifier, candidate.controller.signal, fetchImpl);
      if (candidate.controller.signal.aborted) throw new OAuthFlowError("cancelled", "The OAuth login was cancelled");

      let project: ValidatedProject | undefined;
      try {
        project = await validateProject(token.accessToken, candidate.controller.signal);
      } catch (error) {
        if (candidate.controller.signal.aborted) throw new OAuthFlowError("cancelled", "The OAuth login was cancelled");
        if (error instanceof ProjectDiscoveryError) {
          if (error.code === "cancelled") throw new OAuthFlowError("cancelled", "The OAuth login was cancelled");
          throw new OAuthFlowError(projectErrorCode(error.code), projectErrorMessage(error.code));
        }
        throw error instanceof OAuthFlowError ? error : new OAuthFlowError("project-validation-failed", "Project validation failed");
      }

      if (!project) {
        throw new OAuthFlowError("project-unavailable", "No usable project is available for this account");
      }
      const normalizedProject = normalizeProject(project);

      candidate.commitStarted = true;
      committingGeneration = candidate.generation;
      try {
        await commit(token, normalizedProject, candidate.controller.signal);
      } finally {
        committingGeneration = undefined;
      }

      updateStatus(candidate, { phase: "success" });
      return { completed: true, phase: "success" };
    } catch (error) {
      const safe = classifyCompletionError(error, candidate.controller.signal);
      if (safe.code === "cancelled") {
        updateStatus(candidate, { phase: "cancelled", errorCode: "cancelled" });
        return { completed: false, phase: "cancelled", errorCode: "cancelled" };
      }
      updateStatus(candidate, { phase: "failed", errorCode: safe.code });
      return { completed: false, phase: "failed", errorCode: safe.code };
    } finally {
      if (processing === candidate) processing = undefined;
    }
  };

  const handleLoopbackRequest = async (request: LoopbackRequest): Promise<LoopbackResponse> => {
    try {
      const result = await completeCallback(request);
      if (result.completed) return callbackResponse(200, "success");
      return callbackResponse(result.phase === "cancelled" ? 409 : 400, result.errorCode ?? "failed");
    } catch (error) {
      const safe = error instanceof OAuthFlowError ? error : new OAuthFlowError("internal", "The callback could not be processed");
      return callbackResponse(callbackStatus(safe.code), safe.code);
    }
  };

  return {
    generation: () => committingGeneration ?? generation,
    start: async () => {
      if (disposed) throw new OAuthFlowError("internal", "The OAuth flow is unavailable");
      if (pending) await cancelPending(pending, "cancelled");
      if (processing && !processing.commitStarted) {
        processing.controller.abort(new OAuthFlowError("cancelled", "The OAuth login was cancelled"));
        processing = undefined;
      }

      const verifier = Buffer.from(randomBytes(32)).toString("base64url");
      const state = Buffer.from(randomBytes(32)).toString("base64url");
      const authorizationUrl = buildAuthorizationUrl(state, verifier);
      const expiresAt = Date.now() + ttlMs;
      const candidateGeneration = generation + 1;
      generation = candidateGeneration;

      const candidate: PendingCandidate = {
        authorizationUrl,
        expiresAt,
        state,
        verifier,
        controller: new AbortController(),
        generation: candidateGeneration,
        timeout: setTimeout(() => {
          if (pending === candidate && candidate.active) {
            cancelPending(candidate, "expired").catch(() => {});
          }
        }, ttlMs),
        active: true,
        commitStarted: false
      };
      candidate.timeout.unref();

      pending = candidate;
      currentStatus = {
        phase: "pending",
        authorizationUrl,
        expiresAt: new Date(expiresAt).toISOString()
      };

      try {
        await listenerClosing;
        if (!candidate.active || pending !== candidate) throw new OAuthFlowError("cancelled", "The OAuth login was cancelled");
        candidate.listener = await listenerFactory.listen((req) => handleLoopbackRequest(req));
      } catch (error) {
        clearTimeout(candidate.timeout);
        if (pending === candidate) pending = undefined;
        candidate.active = false;
        const safe = asListenerError(error);
        updateStatus(candidate, {
          phase: safe.code === "port-conflict" ? "port-conflict" : "failed",
          errorCode: safe.code
        });
        throw safe;
      }

      return {
        started: true,
        phase: "pending",
        authorizationUrl,
        expiresAt: new Date(expiresAt).toISOString()
      };
    },
    status: () => currentStatus,
    completeCallbackUrl: async (callbackUrl: string) => {
      if (typeof callbackUrl !== "string" || callbackUrl.length === 0 || callbackUrl.length > MAX_CALLBACK_VALUE_LENGTH) {
        throw new OAuthFlowError("invalid-callback-url", "The callback URL is invalid");
      }
      let parsed: URL;
      try {
        parsed = new URL(callbackUrl);
      } catch {
        throw new OAuthFlowError("invalid-callback-url", "The callback URL is invalid");
      }
      if (parsed.protocol !== "http:" || parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
        throw new OAuthFlowError("invalid-callback-url", "The callback URL is invalid");
      }
      return completeCallback({
        method: "GET",
        host: parsed.host,
        url: `${parsed.pathname}${parsed.search}`
      });
    },
    cancel: async () => {
      if (pending) await cancelPending(pending, "cancelled");
      if (processing && !processing.commitStarted) {
        processing.controller.abort(new OAuthFlowError("cancelled", "The OAuth login was cancelled"));
        updateStatus(processing, { phase: "cancelled", errorCode: "cancelled" });
      }
      return currentStatus;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (pending) await cancelPending(pending, "cancelled");
      if (processing && !processing.commitStarted) {
        processing.controller.abort(new OAuthFlowError("cancelled", "The OAuth login was cancelled"));
        processing = undefined;
      }
      await listenerClosing;
    }
  };
}

export function createNodeLoopbackListenerFactory(): LoopbackListenerFactory {
  return {
    listen: (handler) => {
      const { promise, resolve, reject } = Promise.withResolvers<LoopbackListener>();
      const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const host = typeof request.headers.host === "string" ? request.headers.host : undefined;
        const result = await handler({
          method: request.method ?? "",
          host,
          url: request.url ?? "/"
        });
        response.writeHead(result.status, result.headers as Record<string, string>);
        response.end(result.body);
      });

      let settled = false;
      const onError = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      server.once("error", onError);
      server.listen(ANTIGRAVITY_CALLBACK_PORT, "127.0.0.1", () => {
        settled = true;
        server.removeListener("error", onError);
        resolve({
          close: () => {
            const { promise: closePromise, resolve: resolveClose, reject: rejectClose } = Promise.withResolvers<void>();
            if (!server.listening) {
              resolveClose();
              return closePromise;
            }
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
            return closePromise;
          }
        });
      });

      return promise;
    }
  };
}

export function buildAuthorizationUrl(state: string, verifier: string): string {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function exchangeGoogleCode(
  code: string,
  verifier: string,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch
): Promise<ExchangedToken> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: ANTIGRAVITY_REDIRECT_URI
    }),
    signal
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new OAuthFlowError("token-exchange-failed", "The authorization code could not be exchanged");
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_TOKEN_RESPONSE_BYTES) {
    throw new OAuthFlowError("token-exchange-failed", "The token response was too large");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new OAuthFlowError("token-exchange-failed", "The token response was not valid JSON");
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("access_token" in payload) ||
    !("refresh_token" in payload) ||
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    payload.access_token.length === 0 ||
    payload.refresh_token.length === 0
  ) {
    throw new OAuthFlowError("token-exchange-failed", "The token response was not accepted");
  }

  const expiresIn = "expires_in" in payload && typeof payload.expires_in === "number" && payload.expires_in > 0
    ? payload.expires_in
    : 3600;

  const email = "email" in payload && typeof payload.email === "string" ? payload.email : undefined;

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(email ? { email } : {})
  };
}

function assertCallbackRequest(request: LoopbackRequest): void {
  if (request.method !== "GET") throw new OAuthFlowError("invalid-method", "The OAuth callback method is not accepted");
  if (typeof request.host !== "string" || !isAllowedCallbackHost(request.host)) {
    throw new OAuthFlowError("invalid-host", "The OAuth callback host is not accepted");
  }
  let parsed: URL;
  try {
    parsed = new URL(request.url, `http://${request.host}`);
  } catch {
    throw new OAuthFlowError("invalid-path", "The OAuth callback URL is not accepted");
  }
  if (
    parsed.protocol !== "http:" ||
    !isAllowedCallbackHost(parsed.host) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/oauth-callback" ||
    parsed.hash.length > 0
  ) {
    throw new OAuthFlowError("invalid-path", "The OAuth callback path is not accepted");
  }
}

interface ParsedCallback {
  state: string;
  code?: string;
  error?: string;
}

function parseCallback(urlPath: string): ParsedCallback {
  let parsed: URL;
  try {
    parsed = new URL(urlPath, "http://127.0.0.1:51121");
  } catch {
    throw new OAuthFlowError("invalid-parameters", "The OAuth callback parameters are not accepted");
  }

  const state = parsed.searchParams.get("state");
  if (!state || !isBoundedSafeText(state, MAX_CALLBACK_VALUE_LENGTH)) {
    throw new OAuthFlowError("invalid-parameters", "The OAuth callback state is missing");
  }

  const error = parsed.searchParams.get("error");
  const code = parsed.searchParams.get("code");

  if (error !== null) {
    if (code !== null || !isBoundedSafeText(error, MAX_CALLBACK_VALUE_LENGTH)) {
      throw new OAuthFlowError("invalid-parameters", "The OAuth callback parameters are not accepted");
    }
    return { state, error };
  }

  if (parsed.searchParams.has("error_description") || parsed.searchParams.has("error_uri")) {
    throw new OAuthFlowError("invalid-parameters", "The OAuth callback parameters are not accepted");
  }

  if (code === null || !isBoundedSafeText(code, MAX_CALLBACK_VALUE_LENGTH)) {
    throw new OAuthFlowError("missing-code", "The OAuth callback code is missing");
  }

  return { state, code };
}

function isAllowedCallbackHost(value: string): boolean {
  return ANTIGRAVITY_CALLBACK_HOSTS.includes(value.toLowerCase());
}

function noPendingError(status: OAuthFlowStatus): OAuthFlowError {
  if (status.phase === "expired") return new OAuthFlowError("expired", "The OAuth login expired");
  if (status.phase === "cancelled") return new OAuthFlowError("cancelled", "The OAuth login was cancelled");
  return new OAuthFlowError("no-pending-flow", "There is no pending OAuth login");
}

function asListenerError(error: unknown): OAuthFlowError {
  if (error instanceof OAuthFlowError) return error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") {
    return new OAuthFlowError("port-conflict", "The fixed OAuth callback port is already in use");
  }
  return new OAuthFlowError("internal", "The OAuth callback listener could not start");
}

function classifyCompletionError(error: unknown, signal: AbortSignal): OAuthFlowError {
  if (signal.aborted || (error instanceof OAuthFlowError && error.code === "cancelled")) {
    return new OAuthFlowError("cancelled", "The OAuth login was cancelled");
  }
  if (error instanceof OAuthFlowError) return error;
  return new OAuthFlowError("token-exchange-failed", "The OAuth login could not be completed");
}

function normalizeProject(value: ValidatedProject): ValidatedProject {
  const projectId = normalizeProjectId(value.projectId);
  if (!projectId) throw new OAuthFlowError("project-validation-failed", "Project validation failed");
  return {
    projectId,
    ...(typeof value.email === "string" ? { email: value.email } : {})
  };
}

function projectErrorCode(code: string): string {
  if (code === "authentication") return "project-authentication-failed";
  if (code === "forbidden") return "project-forbidden";
  if (code === "rate-limited") return "project-rate-limited";
  if (code === "offline") return "project-offline";
  if (code === "malformed") return "project-malformed";
  return "project-protocol-drift";
}

function projectErrorMessage(code: string): string {
  if (code === "authentication") return "The Antigravity project probe requires authentication";
  if (code === "forbidden") return "The Antigravity project probe was forbidden";
  if (code === "rate-limited") return "The Antigravity project probe is rate-limited";
  if (code === "offline") return "The Antigravity project probe is offline";
  if (code === "malformed") return "The Antigravity project response was malformed";
  if (code === "protocol-drift") return "The Antigravity project protocol changed";
  return "The Antigravity project probe was cancelled";
}

function callbackResponse(status: number, outcome: string): LoopbackResponse {
  return {
    status,
    headers: EMPTY_RESPONSE_HEADERS,
    body: outcome === "success"
      ? '<!doctype html><meta charset="utf-8"><title>Authorization complete</title><p>Authorization complete. You may return to DeepSeek Harness.</p>'
      : '<!doctype html><meta charset="utf-8"><title>Authorization could not be completed</title><p>Authorization could not be completed. Return to DeepSeek Harness for details.</p>'
  };
}

function callbackStatus(code: string): number {
  if (code === "port-conflict") return 409;
  if (code === "internal") return 500;
  return 400;
}
