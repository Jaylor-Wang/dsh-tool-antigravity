import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET
} from "@cortexkit/antigravity-auth-core";
import { isBoundedSafeText, isRecord } from "./safe-text.js";
import type { AuthStore, AuthStoreRecord } from "./credential-store.js";

export const ANTIGRAVITY_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export type CredentialErrorCode =
  | "invalid-grant"
  | "timeout"
  | "rate-limited"
  | "server-error"
  | "network"
  | "invalid-response"
  | "conflict"
  | "storage"
  | "cancelled"
  | "http-error";

export class CredentialOperationError extends Error {
  readonly code: CredentialErrorCode;
  constructor(code: CredentialErrorCode, message: string = credentialErrorMessage(code) ?? "Credential error") {
    super(message);
    this.name = "CredentialOperationError";
    this.code = code;
  }
}

export interface AntigravityCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  projectId: string;
}

export interface CredentialStatus {
  state: "logged-in" | "logged-out" | "refreshing" | "refresh-failed" | "re-login-required";
  configured: boolean;
  expiresAt?: string;
  lastRefreshAt?: string;
  errorCode?: string;
}

export interface RevokeStatus {
  state: "idle" | "pending" | "confirmation-required" | "revoked" | "failed" | "logged-out" | "superseded";
  errorCode?: string;
}
export type RevokeState = RevokeStatus["state"];
export type RevokeStatusView = RevokeStatus;
export type CredentialStatusView = CredentialStatus;

export interface CredentialCoordinatorOptions {
  store: AuthStore;
  refreshLeadMs?: number;
  operationTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

interface CachedCredential {
  value: AntigravityCredential;
  revision: number;
  lineage?: string;
}

const DEFAULT_REFRESH_LEAD_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const MAX_REFRESH_ATTEMPTS = 3;
const MAX_EXPIRES_IN_SECONDS = 86_400;
const MAX_RESPONSE_BYTES = 65_536;

export interface CredentialCoordinator {
  credential: (signal?: AbortSignal, options?: { forceRefresh?: boolean }) => Promise<AntigravityCredential | undefined>;
  replaceFromLogin: (credential: AntigravityCredential, record: AuthStoreRecord) => void;
  status: () => Promise<CredentialStatus>;
  revokeStatus: () => RevokeStatus;
  logout: () => Promise<{ state: "logged-out" }>;
  revoke: (confirmed: boolean, signal?: AbortSignal) => Promise<RevokeStatus>;
  dispose: () => Promise<void>;
}

export function createCredentialCoordinator(options: CredentialCoordinatorOptions): CredentialCoordinator {
  const now = options.now ?? (() => Date.now());
  const leadMs = options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const refreshAccessToken = createGoogleRefreshTransport(options.fetchImpl ?? globalThis.fetch, now);
  const revokeGrant = createGoogleRevokeTransport(options.fetchImpl ?? globalThis.fetch);

  let cached: CachedCredential | undefined;
  let observedRevision = 0;
  let observedLineage: string | undefined;
  let state: CredentialStatus["state"] = "logged-out";
  let errorCode: string | undefined;
  let lastRefreshAt: number | undefined;
  let revokeStatus: RevokeStatus = { state: "idle" };
  let refreshFlight: Promise<AntigravityCredential | undefined> | undefined;
  let revokeFlight: Promise<RevokeStatus> | undefined;
  let generation = 0;
  let disposed = false;
  const operations = new Set<AbortController>();
  const lifecycleAbort = new AbortController();

  function ensureNotDisposed() {
    if (disposed) throw new CredentialOperationError("cancelled", "The Antigravity credential service is unavailable");
  }

  function beginOperation(): AbortController {
    const controller = new AbortController();
    operations.add(controller);
    if (lifecycleAbort.signal.aborted) controller.abort(lifecycleAbort.signal.reason);
    return controller;
  }

  function endOperation(controller: AbortController) {
    operations.delete(controller);
  }

  function abortOperations() {
    for (const controller of operations) {
      controller.abort(new CredentialOperationError("cancelled"));
    }
    operations.clear();
  }

  function clearObservedCredential() {
    cached = undefined;
    observedRevision = 0;
    observedLineage = undefined;
    if (!disposed) {
      state = "logged-out";
      errorCode = undefined;
      lastRefreshAt = undefined;
    }
  }

  function observe(record: AuthStoreRecord) {
    const lineageChanged = observedRevision !== 0 && observedLineage !== record.lineage;
    if (observedRevision !== 0 && (observedRevision !== record.revision || lineageChanged)) {
      cached = undefined;
      state = "logged-in";
      errorCode = undefined;
      lastRefreshAt = undefined;
    }
    observedRevision = record.revision;
    observedLineage = record.lineage;
    if (state === "logged-out") state = "logged-in";
  }

  function isFresh(credential: AntigravityCredential, timestamp: number, lead: number): boolean {
    return Number.isFinite(credential.expiresAt) && credential.expiresAt - timestamp > lead;
  }

  function makeCredentialStatus(record?: AuthStoreRecord): CredentialStatus {
    const configured = record !== undefined;
    const expiresAt = cached === undefined ? undefined : new Date(cached.value.expiresAt).toISOString();
    return {
      state: configured ? state : "logged-out",
      configured,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(lastRefreshAt === undefined ? {} : { lastRefreshAt: new Date(lastRefreshAt).toISOString() }),
      ...(errorCode === undefined ? {} : { errorCode })
    };
  }

  function isActive(expectedGeneration: number): boolean {
    return !disposed && expectedGeneration === generation;
  }

  function setRefreshFailure(error: unknown) {
    const code = error instanceof CredentialOperationError ? error.code : "network";
    state = code === "invalid-grant" ? "re-login-required" : "refresh-failed";
    errorCode = code;
    cached = undefined;
  }

  function sameLineage(left: { lineage?: string; revision: number }, right: { lineage?: string; revision: number }): boolean {
    if (left.lineage !== undefined || right.lineage !== undefined) return left.lineage === right.lineage;
    return left.revision === right.revision;
  }

  async function refreshCredential(startGeneration: number): Promise<AntigravityCredential | undefined> {
    if (disposed || startGeneration !== generation) return undefined;
    let record = await options.store.read();
    if (!isActive(startGeneration)) return undefined;
    if (!record) {
      clearObservedCredential();
      return undefined;
    }
    observe(record);
    if (state === "re-login-required") return undefined;

    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
      if (!isActive(startGeneration)) return undefined;
      state = "refreshing";
      errorCode = undefined;
      const operation = beginOperation();
      let result: { accessToken: string; expiresAt: number; refreshToken?: string };
      try {
        const currentRefreshToken = record.refreshToken;
        result = await runBounded(
          (signal) => refreshAccessToken({ refreshToken: currentRefreshToken, signal }),
          operation,
          operationTimeoutMs
        );
      } catch (error) {
        endOperation(operation);
        if (!isActive(startGeneration) || (error instanceof CredentialOperationError && error.code === "cancelled")) {
          return undefined;
        }
        setRefreshFailure(error);
        return undefined;
      }
      endOperation(operation);
      if (!isActive(startGeneration)) return undefined;

      const current = await options.store.read();
      if (!isActive(startGeneration)) return undefined;
      const responseRefreshToken = result.refreshToken ?? record.refreshToken;

      if (!current) {
        clearObservedCredential();
        return undefined;
      }

      if (sameLineage(current, record) && current.revision !== record.revision) {
        if (current.refreshToken === responseRefreshToken) {
          return adoptRefreshedCredential(result, current, startGeneration);
        }
        record = current;
        observe(record);
        continue;
      }

      const committed = await options.store.compareAndCommit(
        record.revision,
        {
          refreshToken: responseRefreshToken,
          projectId: record.projectId,
          ...(record.email === undefined ? {} : { email: record.email }),
          ...(record.lineage === undefined ? {} : { lineage: record.lineage })
        },
        record.lineage
      );

      if (committed !== undefined) {
        return adoptRefreshedCredential(result, committed, startGeneration);
      }

      const latest = await options.store.read();
      if (!isActive(startGeneration)) return undefined;
      if (!latest) {
        clearObservedCredential();
        return undefined;
      }
      if (latest.refreshToken === responseRefreshToken && sameLineage(latest, record)) {
        return adoptRefreshedCredential(result, latest, startGeneration);
      }
      record = latest;
      observe(record);
    }

    if (isActive(startGeneration)) {
      state = "refresh-failed";
      errorCode = "conflict";
    }
    return undefined;
  }

  function adoptRefreshedCredential(
    result: { accessToken: string; expiresAt: number; refreshToken?: string },
    record: AuthStoreRecord,
    startGeneration: number
  ): AntigravityCredential | undefined {
    if (!isActive(startGeneration)) return undefined;
    const credential: AntigravityCredential = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? record.refreshToken,
      expiresAt: result.expiresAt,
      projectId: record.projectId
    };
    cached = {
      value: credential,
      revision: record.revision,
      ...(record.lineage === undefined ? {} : { lineage: record.lineage })
    };
    observedRevision = record.revision;
    observedLineage = record.lineage;
    state = "logged-in";
    errorCode = undefined;
    lastRefreshAt = now();
    return { ...credential };
  }

  async function revokeCredential(record: AuthStoreRecord, revokeGeneration: number): Promise<RevokeStatus> {
    const operation = beginOperation();
    try {
      await runBounded((signal) => revokeGrant({ token: record.refreshToken, signal }), operation, operationTimeoutMs);
    } catch (error) {
      endOperation(operation);
      if (!isActive(revokeGeneration)) return { state: "superseded" };
      const code = error instanceof CredentialOperationError ? error.code : "network";
      revokeStatus = { state: "failed", errorCode: code };
      return { state: "failed", errorCode: code };
    }
    endOperation(operation);
    if (!isActive(revokeGeneration)) return { state: "superseded" };

    let cleared: boolean;
    try {
      cleared = await options.store.clearIfCurrent(record.revision, record.lineage);
    } catch {
      if (!isActive(revokeGeneration)) return { state: "superseded" };
      revokeStatus = { state: "failed", errorCode: "storage" };
      return { state: "failed", errorCode: "storage" };
    }

    if (!isActive(revokeGeneration)) return { state: "superseded" };
    if (!cleared) {
      revokeStatus = { state: "superseded" };
      return { state: "superseded" };
    }

    cached = undefined;
    observedRevision = 0;
    observedLineage = undefined;
    state = "logged-out";
    errorCode = undefined;
    lastRefreshAt = undefined;
    revokeStatus = { state: "revoked" };
    return { state: "revoked" };
  }

  return {
    credential: async (signal, opts = {}): Promise<AntigravityCredential | undefined> => {
      ensureNotDisposed();
      if (signal?.aborted) throw new CredentialOperationError("cancelled");

      const timestamp = now();
      const record = await options.store.read();
      if (!record) {
        clearObservedCredential();
        return undefined;
      }
      observe(record);

      if (
        !opts.forceRefresh &&
        cached !== undefined &&
        cached.revision === record.revision &&
        cached.lineage === record.lineage &&
        isFresh(cached.value, timestamp, leadMs)
      ) {
        return { ...cached.value };
      }

      if (refreshFlight !== undefined) {
        return await waitForCaller(refreshFlight, signal);
      }

      const currentGeneration = generation;
      const flight = refreshCredential(currentGeneration);
      refreshFlight = flight;
      flight.finally(() => {
        if (refreshFlight === flight) refreshFlight = undefined;
      });

      return await waitForCaller(flight, signal);
    },

    replaceFromLogin: (credential, record) => {
      generation += 1;
      abortOperations();
      cached = {
        value: { ...credential },
        revision: record.revision,
        ...(record.lineage === undefined ? {} : { lineage: record.lineage })
      };
      observedRevision = record.revision;
      observedLineage = record.lineage;
      state = "logged-in";
      errorCode = undefined;
      lastRefreshAt = undefined;
      revokeStatus = { state: "idle" };
      refreshFlight = undefined;
      revokeFlight = undefined;
    },

    status: async (): Promise<CredentialStatus> => {
      ensureNotDisposed();
      const record = await options.store.read();
      if (!record) clearObservedCredential();
      else observe(record);
      return makeCredentialStatus(record);
    },

    revokeStatus: () => ({ ...revokeStatus }),

    logout: async (): Promise<{ state: "logged-out" }> => {
      ensureNotDisposed();
      generation += 1;
      const logoutGeneration = generation;
      abortOperations();
      refreshFlight = undefined;
      revokeFlight = undefined;
      cached = undefined;
      observedRevision = 0;
      observedLineage = undefined;
      const record = await options.store.read();
      if (!isActive(logoutGeneration)) return { state: "logged-out" };
      let cleared = true;
      if (record !== undefined) {
        cleared = await options.store.clearIfCurrent(record.revision, record.lineage);
      }
      if (!isActive(logoutGeneration)) return { state: "logged-out" };
      if (!cleared) {
        const latest = await options.store.read();
        if (!isActive(logoutGeneration)) return { state: "logged-out" };
        if (latest === undefined) {
          clearObservedCredential();
          revokeStatus = { state: "logged-out" };
        } else observe(latest);
        return { state: "logged-out" };
      }
      state = "logged-out";
      errorCode = undefined;
      lastRefreshAt = undefined;
      revokeStatus = { state: "logged-out" };
      return { state: "logged-out" };
    },

    revoke: async (confirmed, signal): Promise<RevokeStatus> => {
      ensureNotDisposed();
      if (!confirmed) {
        revokeStatus = { state: "confirmation-required" };
        return { state: "confirmation-required" };
      }
      if (signal?.aborted) throw new CredentialOperationError("cancelled");
      if (revokeFlight !== undefined) return await waitForCaller(revokeFlight, signal);
      generation += 1;
      abortOperations();
      refreshFlight = undefined;
      const revokeGeneration = generation;
      const record = await options.store.read();
      if (!isActive(revokeGeneration)) return { state: "superseded" };
      if (record === undefined) {
        clearObservedCredential();
        revokeStatus = { state: "logged-out" };
        return { state: "logged-out" };
      }
      revokeStatus = { state: "pending" };
      const flight = revokeCredential(record, revokeGeneration);
      revokeFlight = flight;
      flight.finally(() => {
        if (revokeFlight === flight) revokeFlight = undefined;
      });
      return await waitForCaller(flight, signal);
    },

    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      lifecycleAbort.abort(new CredentialOperationError("cancelled", "The Antigravity credential service was disposed"));
      abortOperations();
      refreshFlight = undefined;
      revokeFlight = undefined;
      cached = undefined;
      operations.clear();
    }
  };
}

function createGoogleRefreshTransport(fetchImpl: typeof globalThis.fetch, now: () => number) {
  return async ({ refreshToken, signal }: { refreshToken: string; signal: AbortSignal }) => {
    let response: Response;
    try {
      response = await fetchImpl(ANTIGRAVITY_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
        },
        body: new URLSearchParams({
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken
        }),
        signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new CredentialOperationError("cancelled");
      throw new CredentialOperationError("network");
    }

    if (!response.ok && (response.status === 429 || response.status >= 500)) throw responseError(response.status);
    const body = await readJsonBody(response);
    if (!response.ok) throw responseError(response.status, body);
    if (!isRecord(body) || typeof body.access_token !== "string" || !isBoundedSafeText(body.access_token, 4096)) {
      throw new CredentialOperationError("invalid-response");
    }
    const expiresIn = body.expires_in;
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN_SECONDS) {
      throw new CredentialOperationError("invalid-response");
    }
    const nextRefreshToken = body.refresh_token;
    if (nextRefreshToken !== undefined && (typeof nextRefreshToken !== "string" || !isBoundedSafeText(nextRefreshToken, 4096))) {
      throw new CredentialOperationError("invalid-response");
    }
    return {
      accessToken: body.access_token,
      expiresAt: now() + expiresIn * 1000,
      ...(nextRefreshToken === undefined ? {} : { refreshToken: nextRefreshToken })
    };
  };
}

function createGoogleRevokeTransport(fetchImpl: typeof globalThis.fetch) {
  return async ({ token, signal }: { token: string; signal: AbortSignal }) => {
    let response: Response;
    try {
      response = await fetchImpl(ANTIGRAVITY_REVOKE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "*/*"
        },
        body: new URLSearchParams({ token }),
        signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new CredentialOperationError("cancelled");
      throw new CredentialOperationError("network");
    }
    if (!response.ok) throw responseError(response.status);
  };
}

async function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortController,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const { promise, resolve, reject } = Promise.withResolvers<T>();

  const timer = setTimeout(() => {
    controller.abort(new CredentialOperationError("timeout"));
    reject(new CredentialOperationError("timeout"));
  }, timeoutMs);
  timer.unref();

  const onParentAbort = () => {
    controller.abort(parent.signal.reason);
    reject(new CredentialOperationError("cancelled"));
  };

  if (parent.signal.aborted) onParentAbort();
  else parent.signal.addEventListener("abort", onParentAbort, { once: true });

  operation(controller.signal)
    .then((val) => {
      clearTimeout(timer);
      parent.signal.removeEventListener("abort", onParentAbort);
      resolve(val);
    })
    .catch((err) => {
      clearTimeout(timer);
      parent.signal.removeEventListener("abort", onParentAbort);
      reject(err);
    });

  return promise;
}

async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw new CredentialOperationError("cancelled");

  const { promise: callerPromise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;

  const onAbort = () => {
    if (settled) return;
    settled = true;
    reject(new CredentialOperationError("cancelled"));
  };

  signal.addEventListener("abort", onAbort, { once: true });

  promise
    .then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    })
    .catch((error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });

  return callerPromise;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new CredentialOperationError("invalid-response");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CredentialOperationError("invalid-response");
  }
}

function responseError(status: number, body?: unknown): CredentialOperationError {
  if (status === 400 && isRecord(body) && body.error === "invalid_grant") {
    return new CredentialOperationError("invalid-grant");
  }
  if (status === 408 || status === 504) return new CredentialOperationError("timeout");
  if (status === 429) return new CredentialOperationError("rate-limited");
  if (status >= 500 && status <= 599) return new CredentialOperationError("server-error");
  return new CredentialOperationError("http-error");
}


export function credentialErrorMessage(code: CredentialErrorCode): string | undefined {
  switch (code) {
    case "invalid-grant":
      return "The Antigravity grant requires login again";
    case "timeout":
      return "The Antigravity authentication request timed out";
    case "rate-limited":
      return "The Antigravity authentication service is rate-limited";
    case "server-error":
      return "The Antigravity authentication service is unavailable";
    case "network":
      return "The Antigravity authentication request failed";
    case "invalid-response":
      return "The Antigravity authentication response was invalid";
    case "conflict":
      return "The Antigravity credential changed while it was refreshing";
    case "storage":
      return "The Antigravity credential store failed";
    case "cancelled":
      return "The Antigravity authentication request was cancelled";
    case "http-error":
      return "The Antigravity authentication service rejected the request";
  }
}
