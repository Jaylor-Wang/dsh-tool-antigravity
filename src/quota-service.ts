/**
 * Antigravity quota service and window normalization.
 *
 * Implements resilient window identification (5h, weekly), ISO duration parsing,
 * group classification (Gemini vs Non-Gemini), in-flight deduplication, and SWR cache tolerance.
 */
export interface QuotaCredential {
  readonly accessToken: string;
  readonly projectId?: string;
}
import { classifyPrivateFailure } from "./private-failure.js";
import {
  createPrivateTransport,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  privateStatusError,
  PrivateTransportError,
  readPrivateText,
  type PrivateTransport,
  type PrivateTransportOptions
} from "./private-transport.js";
import { isRecord } from "./safe-text.js";
import { ANTIGRAVITY_WIRE_ORIGIN } from "./wire-identity.js";

export const ANTIGRAVITY_QUOTA_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:retrieveUserQuotaSummary`;
export const QUOTA_REFRESH_MIN_INTERVAL_MS = 30000;

export type QuotaWindowType = "5h" | "weekly";
export type QuotaGroupType = "gemini" | "non-gemini";
export type QuotaState =
  | "available"
  | "unauthenticated"
  | "forbidden"
  | "rate-limited"
  | "offline"
  | "refresh-failed"
  | "protocol-drift";

export interface QuotaWindowInfo {
  readonly window: QuotaWindowType;
  readonly remainingFraction: number;
  readonly resetTime: string;
}

export interface QuotaGroupInfo {
  readonly group: QuotaGroupType;
  readonly modelCount: number;
  readonly windows: readonly QuotaWindowInfo[];
}

export interface QuotaSnapshot {
  readonly state: QuotaState;
  readonly checkedAt: string;
  readonly groups?: readonly QuotaGroupInfo[];
  readonly stale?: boolean;
  readonly error?: string;
}
export type QuotaStatusView = QuotaSnapshot;

export interface QuotaServiceOptions {
  readonly auth: {
    credential(signal?: AbortSignal): Promise<QuotaCredential | undefined>;
  };
  readonly transport?: PrivateTransport;
  readonly transportOptions?: PrivateTransportOptions;
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}

export interface QuotaService {
  refresh(signal?: AbortSignal, force?: boolean): Promise<QuotaSnapshot>;
  status(): QuotaSnapshot;
  dispose(): Promise<void>;
}

export class QuotaNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaNormalizationError";
  }
}

const QUOTA_FAILURE_STATES: Record<string, QuotaState> = {
  authentication: "unauthenticated",
  forbidden: "forbidden",
  "rate-limited": "rate-limited",
  cancelled: "offline",
  timeout: "offline",
  "attribution-rejected": "protocol-drift",
  "protocol-drift": "protocol-drift",
  "response-limit": "protocol-drift",
  "request-limit": "protocol-drift",
  upstream: "refresh-failed",
  network: "offline",
  failed: "refresh-failed"
};

export function createQuotaService(options: QuotaServiceOptions): QuotaService {
  const now = options.now ?? (() => Date.now());
  const minInterval = positive(options.minIntervalMs, QUOTA_REFRESH_MIN_INTERVAL_MS);
  const transport =
    options.transport ??
    createPrivateTransport({
      ...options.transportOptions?.responseHeaderTimeoutMs === undefined
        ? {}
        : { responseHeaderTimeoutMs: options.transportOptions.responseHeaderTimeoutMs },
      ...options.transportOptions?.maxRequestBytes === undefined
        ? {}
        : { maxRequestBytes: options.transportOptions.maxRequestBytes }
    });

  let current: QuotaSnapshot = {
    state: "unauthenticated",
    checkedAt: new Date(now()).toISOString()
  };
  let lastSuccessfulGroups: readonly QuotaGroupInfo[] | undefined;
  let checkedAt = 0;
  let inFlight: Promise<QuotaSnapshot> | undefined;
  let inFlightAbort: (() => void) | undefined;
  const lifecycleController = new AbortController();
  let disposed = false;

  return {
    refresh: async (signal?: AbortSignal, force = false): Promise<QuotaSnapshot> => {
      if (disposed) return current;
      if (!force && checkedAt > 0 && now() - checkedAt < minInterval) {
        return current;
      }
      if (inFlight !== undefined) {
        return await waitForCaller(inFlight, signal);
      }

      const combined = mergeAbortSignals(signal, lifecycleController.signal);
      inFlightAbort = combined.dispose;

      inFlight = refreshQuota(options.auth, transport, combined.signal, now)
        .then((value) => {
          current = value;
          if (value.state === "available" && value.groups) {
            lastSuccessfulGroups = value.groups;
          }
          checkedAt = now();
          return value;
        })
        .catch((error: unknown) => {
          const mapped = mapQuotaError(error, now());
          // SWR: Preserve previous successful groups with stale flag
          if (lastSuccessfulGroups !== undefined) {
            current = {
              ...mapped,
              groups: lastSuccessfulGroups,
              stale: true,
              error: error instanceof Error ? error.message : String(error)
            };
          } else {
            current = mapped;
          }
          checkedAt = now();
          return current;
        })
        .finally(() => {
          combined.dispose();
          inFlightAbort = undefined;
          inFlight = undefined;
        });

      return await waitForCaller(inFlight, signal);
    },
    status: (): QuotaSnapshot => current,
    dispose: async (): Promise<void> => {
      disposed = true;
      lifecycleController.abort();
      inFlightAbort?.();
      await inFlight?.catch(() => {});
    }
  };
}

async function refreshQuota(
  auth: QuotaServiceOptions["auth"],
  transport: PrivateTransport,
  signal: AbortSignal | undefined,
  now: () => number
): Promise<QuotaSnapshot> {
  const credential = await auth.credential(signal);
  if (credential === undefined) {
    return {
      state: "unauthenticated",
      checkedAt: new Date(now()).toISOString()
    };
  }

  const body = credential.projectId ? { project: credential.projectId } : {};
  let response = await transport.request({
    url: ANTIGRAVITY_QUOTA_ENDPOINT,
    accessToken: credential.accessToken,
    body: JSON.stringify(body),
    ...signal === undefined ? {} : { signal }
  });

  if (response.status === 403 && credential.projectId) {
    try {
      const retryResponse = await transport.request({
        url: ANTIGRAVITY_QUOTA_ENDPOINT,
        accessToken: credential.accessToken,
        body: JSON.stringify({}),
        ...signal === undefined ? {} : { signal }
      });
      if (retryResponse.ok) {
        response = retryResponse;
      }
    } catch {}
  }

  const statusError = privateStatusError(response.status);
  if (statusError !== undefined) {
    await response.body?.cancel().catch(() => {});
    throw statusError;
  }

  let value: unknown;
  try {
    value = JSON.parse(
      await readPrivateText(response, {
        ...signal === undefined ? {} : { signal },
        maxBytes: DEFAULT_PRIVATE_RESPONSE_BYTES
      })
    );
  } catch (error) {
    if (error instanceof PrivateTransportError) throw error;
    throw new QuotaNormalizationError("The quota response was not valid JSON");
  }

  return normalizeQuotaResponse(value, now());
}

/**
 * Normalize validated quota facts from raw provider JSON response.
 */
export function normalizeQuotaResponse(value: unknown, now = Date.now()): QuotaSnapshot {
  const groups: QuotaGroupInfo[] = [];
  const sourceValue = isRecord(value) && isRecord(value.response) ? value.response : value;
  const source = isRecord(sourceValue) ? sourceValue : undefined;

  const candidates: unknown[] =
    source === undefined
      ? []
      : [
          ...Array.isArray(source.groups) ? source.groups : [],
          ...Array.isArray(source.buckets) ? source.buckets : [],
          ...Array.isArray(source.quotaBuckets) ? source.quotaBuckets : [],
          ...Array.isArray(source.quota_buckets) ? source.quota_buckets : [],
          ...Array.isArray(source.userQuotaSummary) ? source.userQuotaSummary : [],
          ...Array.isArray(source.quotas) ? source.quotas : []
        ];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const buckets = Array.isArray(candidate.buckets)
      ? candidate.buckets
      : Array.isArray(candidate.quotaBuckets)
        ? candidate.quotaBuckets
        : Array.isArray(candidate.windows)
          ? candidate.windows
          : [candidate];

    for (const rawBucket of buckets) {
      if (!isRecord(rawBucket)) continue;
      const window = identifyWindow(rawBucket);
      const resetTime = normalizeResetTime(
        rawBucket.resetTime ?? rawBucket.reset_time ?? rawBucket.resetAt ?? rawBucket.reset_at,
        now
      );
      const fraction = normalizeFraction(
        rawBucket.remainingFraction ??
          rawBucket.remaining_fraction ??
          rawBucket.fraction ??
          rawBucket.remaining ??
          rawBucket.remaining_percent ??
          rawBucket.percentage
      );

      if (window === undefined || resetTime === undefined || fraction === undefined) {
        continue;
      }

      const group = identifyGroup(candidate, rawBucket);
      if (group === undefined) continue;

      const modelCount = boundedCount(
        candidate.modelCount ??
          candidate.model_count ??
          candidate.models ??
          descriptionModelCount(candidate.description)
      );

      const existing = groups.find((item) => item.group === group);
      if (existing === undefined) {
        groups.push({
          group,
          modelCount,
          windows: [{ window, remainingFraction: fraction, resetTime }]
        });
      } else if (!existing.windows.some((item) => item.window === window)) {
        const updated: QuotaGroupInfo = {
          group,
          modelCount: Math.max(existing.modelCount, modelCount),
          windows: [...existing.windows, { window, remainingFraction: fraction, resetTime }].sort(
            windowOrder
          )
        };
        const idx = groups.indexOf(existing);
        groups.splice(idx, 1, updated);
      } else {
        const updatedWindows = existing.windows.map((item) =>
          item.window === window
            ? {
                window,
                remainingFraction: Math.min(item.remainingFraction, fraction),
                resetTime: item.resetTime
              }
            : item
        );
        const updated: QuotaGroupInfo = {
          group,
          modelCount: Math.max(existing.modelCount, modelCount),
          windows: updatedWindows.sort(windowOrder)
        };
        const idx = groups.indexOf(existing);
        groups.splice(idx, 1, updated);
      }
    }
  }

  if (groups.length === 0) {
    if (isRecord(source)) {
      return {
        state: "available",
        checkedAt: new Date(now).toISOString(),
        groups: []
      };
    }
    throw new QuotaNormalizationError("The quota response did not contain recognized windows");
  }

  return {
    state: "available",
    checkedAt: new Date(now).toISOString(),
    groups: groups.sort((left, right) => left.group.localeCompare(right.group))
  };
}

export function identifyWindow(value: Record<string, unknown>): QuotaWindowType | undefined {
  const raw = String(
    value.window ??
      value.windowType ??
      value.window_type ??
      value.bucketId ??
      value.bucket_id ??
      value.duration ??
      ""
  ).toLowerCase();

  // Match keyword patterns
  if (raw.includes("5h") || raw.includes("5-hour") || raw.includes("five") || raw.includes("pt5h")) {
    return "5h";
  }
  if (
    raw.includes("week") ||
    raw.includes("weekly") ||
    raw.includes("7d") ||
    raw.includes("7-day") ||
    raw.includes("p7d") ||
    raw.includes("p1w")
  ) {
    return "weekly";
  }

  // Parse numeric duration (seconds or milliseconds)
  const seconds = parseDurationInSeconds(value.durationSeconds ?? value.duration_seconds ?? value.duration);
  if (seconds !== undefined) {
    // 3h to 8h is classified as 5h window (18000s)
    if (seconds >= 10800 && seconds <= 28800) return "5h";
    // 5d to 10d is classified as weekly window (604800s)
    if (seconds >= 432000 && seconds <= 864000) return "weekly";
    // Fallbacks for bounds
    if (seconds <= 21600) return "5h";
    if (seconds <= 691200) return "weekly";
  }

  return undefined;
}

function parseDurationInSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Any quota duration >= 10,000,000 (e.g. 5h in ms is 18,000,000) is in milliseconds
    return value >= 10000000 ? value / 1000 : value;
  }
  if (typeof value === "string") {
    // String seconds like "18000s"
    if (/^\d+(\.\d+)?s$/i.test(value)) {
      return Number.parseFloat(value.slice(0, -1));
    }
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export function identifyGroup(
  candidate: Record<string, unknown>,
  bucket?: Record<string, unknown>
): QuotaGroupType {
  const raw = [
    candidate.displayName,
    candidate.group,
    candidate.quotaGroup,
    candidate.quota_group,
    candidate.modelFamily,
    candidate.title,
    candidate.name,
    candidate.description,
    bucket?.bucketId,
    bucket?.bucket_id,
    bucket?.displayName
  ]
    .filter(Boolean)
    .map(String)
    .join(" ")
    .toLowerCase();

  if (
    raw.includes("3p") ||
    raw.includes("non") ||
    raw.includes("claude") ||
    raw.includes("gpt") ||
    raw.includes("openai") ||
    raw.includes("anthropic") ||
    raw.includes("third-party") ||
    raw.includes("external")
  ) {
    return "non-gemini";
  }

  return "gemini";
}

export function normalizeFraction(value: unknown): number | undefined {
  const num = numberValue(value);
  if (num === undefined) return undefined;
  if (num >= 0 && num <= 1) return num;
  if (num <= 100) return num / 100;
  return undefined;
}

export function normalizeResetTime(value: unknown, now: number): string | undefined {
  const parsed =
    typeof value === "number"
      ? value < 1e10
        ? value * 1e3
        : value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0x5af3107a4000) {
    return undefined;
  }

  const iso = new Date(parsed).toISOString();
  return Number.isFinite(Date.parse(iso)) && parsed >= now - 31536000000 ? iso : undefined;
}

function boundedCount(value: unknown): number {
  if (Array.isArray(value)) return Math.min(value.length, 10000);
  const num = numberValue(value);
  return num === undefined ? 0 : Math.min(Math.floor(num), 10000);
}

function descriptionModelCount(value: unknown): number {
  if (typeof value !== "string" || value.length === 0 || value.length > 16384) return 0;
  if (!/^[^:]{1,256}:\s*/u.test(value)) return 0;
  const payload = value.replace(/^[^:]{1,256}:\s*/u, "");
  return Math.min(
    payload.split(",").map((item) => item.trim()).filter((item) => item.length > 0).length,
    10000
  );
}

function windowOrder(left: QuotaWindowInfo, right: QuotaWindowInfo): number {
  return left.window === right.window ? 0 : left.window === "5h" ? -1 : 1;
}

function positive(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.min(Math.floor(value), 86400000);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mapQuotaError(error: unknown, checkedAt: number): QuotaSnapshot {
  return {
    state:
      error instanceof PrivateTransportError
        ? QUOTA_FAILURE_STATES[classifyPrivateFailure(error)] ?? "refresh-failed"
        : error instanceof QuotaNormalizationError
          ? "protocol-drift"
          : "offline",
    checkedAt: new Date(checkedAt).toISOString()
  };
}

async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("The operation was aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("The operation was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function mergeAbortSignals(
  first?: AbortSignal,
  second?: AbortSignal
): { signal?: AbortSignal; dispose: () => void } {
  if (!first && !second) return { dispose: () => {} };
  if (!first) return { signal: second, dispose: () => {} };
  if (!second) return { signal: first, dispose: () => {} };

  const controller = new AbortController();
  const onFirst = () => controller.abort(first.reason);
  const onSecond = () => controller.abort(second.reason);

  if (first.aborted) {
    controller.abort(first.reason);
  } else if (second.aborted) {
    controller.abort(second.reason);
  } else {
    first.addEventListener("abort", onFirst, { once: true });
    second.addEventListener("abort", onSecond, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener("abort", onFirst);
      second.removeEventListener("abort", onSecond);
    }
  };
}
