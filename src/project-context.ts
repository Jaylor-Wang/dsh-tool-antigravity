import {
  DEFAULT_PRIVATE_IDLE_TIMEOUT_MS,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS,
  PrivateTransportError,
  createPrivateTransport,
  privateStatusError,
  readPrivateText,
  type PrivateTransport,
  type PrivateTransportOptions
} from "./private-transport.js";
import { ANTIGRAVITY_WIRE_ORIGIN } from "./wire-identity.js";
import { classifyPrivateFailure, type ClassifiedFailure } from "./private-failure.js";
import { buildAntigravityLoadCodeAssistMetadata } from "@cortexkit/antigravity-auth-core";

const PROJECT_DISCOVERY_PATH = "/v1internal:loadCodeAssist";
const PROJECT_DISCOVERY_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}${PROJECT_DISCOVERY_PATH}`;
const MAX_RESPONSE_BYTES = Math.min(DEFAULT_PRIVATE_RESPONSE_BYTES, 65_536);
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const MAX_OPERATION_TIMEOUT_MS = 600_000;
const MAX_PROJECT_ID_LENGTH = 128;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{2,127}$/u;

export type ProjectDiscoveryErrorCode =
  | "authentication"
  | "forbidden"
  | "rate-limited"
  | "offline"
  | "malformed"
  | "protocol-drift"
  | "cancelled";

export class ProjectDiscoveryError extends Error {
  readonly code: ProjectDiscoveryErrorCode;
  constructor(code: ProjectDiscoveryErrorCode, message: string = projectDiscoveryErrorMessage(code)) {
    super(message);
    this.name = "ProjectDiscoveryError";
    this.code = code;
  }
}

export interface DiscoveredProject {
  projectId: string;
}

export interface ProjectDiscovery {
  discover: (accessToken: string, signal?: AbortSignal) => Promise<DiscoveredProject | undefined>;
}

export interface ProjectDiscoveryOptions {
  operationTimeoutMs?: number;
  transport?: PrivateTransport;
  transportOptions?: PrivateTransportOptions;
}

export function createProjectDiscovery(options: ProjectDiscoveryOptions = {}): ProjectDiscovery {
  const timeoutMs = boundedTimeout(options.operationTimeoutMs);
  const transport = options.transport ?? createPrivateTransport(options.transportOptions);

  return {
    discover: async (accessToken: string, signal?: AbortSignal): Promise<DiscoveredProject | undefined> => {
      if (signal?.aborted) throw new ProjectDiscoveryError("cancelled");

      const body = JSON.stringify({ metadata: buildAntigravityLoadCodeAssistMetadata() });
      let response: Response;
      try {
        response = await transport.request({
          url: PROJECT_DISCOVERY_ENDPOINT,
          accessToken,
          body,
          ...(signal ? { signal } : {}),
          responseHeaderTimeoutMs: timeoutMs
        });
      } catch (error) {
        throw mapTransportError(error);
      }

      const statusError = privateStatusError(response.status);
      if (statusError) {
        await response.body?.cancel().catch(() => {});
        throw mapTransportError(statusError);
      }

      try {
        const text = await readPrivateText(response, {
          ...(signal ? { signal } : {}),
          idleTimeoutMs: Math.min(timeoutMs, DEFAULT_PRIVATE_IDLE_TIMEOUT_MS),
          totalTimeoutMs: Math.min(timeoutMs, DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS),
          maxBytes: MAX_RESPONSE_BYTES
        });

        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new ProjectDiscoveryError("malformed");
        }
        return parseProjectResponse(value);
      } catch (error) {
        if (error instanceof ProjectDiscoveryError) throw error;
        throw mapTransportError(error);
      }
    }
  };
}

export const createProjectContext = createProjectDiscovery;

export function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_PROJECT_ID_LENGTH) return undefined;
  return PROJECT_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function parseProjectResponse(value: unknown): DiscoveredProject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectDiscoveryError("malformed");
  }
  const obj = value as Record<string, unknown>;
  if (!Object.hasOwn(obj, "cloudaicompanionProject")) return undefined;

  const candidate = obj.cloudaicompanionProject;
  if (candidate === null || candidate === undefined) return undefined;

  if (typeof candidate === "string") {
    if (candidate.trim().length === 0) return undefined;
    return projectFromValue(candidate);
  }

  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ProjectDiscoveryError("protocol-drift");
  }
  const candObj = candidate as Record<string, unknown>;
  if (!Object.hasOwn(candObj, "id")) return undefined;
  if (candObj.id === null || candObj.id === undefined) {
    throw new ProjectDiscoveryError("protocol-drift");
  }
  return projectFromValue(candObj.id);
}

function projectFromValue(value: unknown): DiscoveredProject {
  const projectId = normalizeProjectId(value);
  if (projectId === undefined) throw new ProjectDiscoveryError("protocol-drift");
  return { projectId };
}

function boundedTimeout(value?: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_OPERATION_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_OPERATION_TIMEOUT_MS);
}

const PROJECT_FAILURE_CODES: Record<ClassifiedFailure, ProjectDiscoveryErrorCode> = {
  authentication: "authentication",
  forbidden: "forbidden",
  "rate-limited": "rate-limited",
  cancelled: "cancelled",
  timeout: "offline",
  "attribution-rejected": "protocol-drift",
  "protocol-drift": "protocol-drift",
  "response-limit": "protocol-drift",
  "request-limit": "protocol-drift",
  upstream: "offline",
  network: "offline",
  failed: "offline"
};

function mapTransportError(error: unknown): ProjectDiscoveryError {
  if (error instanceof ProjectDiscoveryError) return error;
  if (error instanceof PrivateTransportError) {
    const classified = classifyPrivateFailure(error);
    const code = PROJECT_FAILURE_CODES[classified] ?? "offline";
    return new ProjectDiscoveryError(code);
  }
  return new ProjectDiscoveryError("offline");
}

export function projectDiscoveryErrorMessage(code: ProjectDiscoveryErrorCode): string {
  switch (code) {
    case "authentication":
      return "The Antigravity project probe requires authentication";
    case "forbidden":
      return "The Antigravity project probe was forbidden";
    case "rate-limited":
      return "The Antigravity project probe is rate-limited";
    case "offline":
      return "The Antigravity project probe is offline";
    case "malformed":
      return "The Antigravity project response was malformed";
    case "protocol-drift":
      return "The Antigravity project protocol changed";
    case "cancelled":
      return "The Antigravity project probe was cancelled";
  }
}
