/** Host dispatcher for Antigravity account RPC. */

import type { ConnectionRpcResult as RpcResult } from "@deepseek-ai/dsh-client-connection";
import type { AntigravityAuthService } from "./auth-service.js";
import { openPlatformBrowser } from "./utils/process-opener.js";
import { isRecord } from "./safe-text.js";

export { ANTIGRAVITY_AUTH_RPC_CHANNEL, ANTIGRAVITY_AUTH_RPC_NAMESPACE } from "./rpc-contract.js";

export const ANTIGRAVITY_AUTH_RPC_ENDPOINTS = [
  "status",
  "models",
  "usage",
  "acknowledge-risk",
  "login",
  "cancel",
  "cancel-login",
  "logout",
  "revoke"
] as const;

export async function handleAntigravityAuthRpc(
  service: AntigravityAuthService,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<RpcResult<unknown>> {
  if (signal?.aborted === true) {
    return { ok: false, error: { code: "cancelled", message: "antigravity-auth: request cancelled", details: {} } };
  }

  try {
    if (endpoint === "status") {
      if (!isEmptyRecord(payload)) return badRequest("status expects an empty payload");
      return { ok: true, value: { status: await service.status() } };
    }
    if (endpoint === "models") {
      if (!isRefreshPayload(payload)) return badRequest("models expects {} or { force: boolean }");
      return { ok: true, value: { state: "unauthenticated", models: [] } };
    }
    if (endpoint === "usage") {
      if (!isRefreshPayload(payload)) return badRequest("usage expects {} or { force: boolean }");
      return { ok: true, value: await service.usage(signal, payload.force) };
    }
    if (endpoint === "acknowledge-risk") {
      if (!isAcknowledgement(payload)) return badRequest("acknowledge-risk expects { acknowledge: true }");
      return { ok: true, value: service.acknowledgeRisk() };
    }
    if (endpoint === "login") {
      if (!isEmptyRecord(payload)) return badRequest("login expects an empty payload");
      const start = await service.startLogin();
      if (start.authorizationUrl) void openPlatformBrowser(start.authorizationUrl);
      return { ok: true, value: start };
    }
    if (endpoint === "cancel" || endpoint === "cancel-login") {
      if (!isEmptyRecord(payload)) return badRequest("cancel expects an empty payload");
      return { ok: true, value: await service.cancelLogin() };
    }
    if (endpoint === "logout") {
      if (!isEmptyRecord(payload)) return badRequest("logout expects an empty payload");
      return { ok: true, value: await service.logout() };
    }
    if (endpoint === "revoke") {
      if (!isRevokePayload(payload)) return badRequest("revoke expects { confirmed: true }");
      return { ok: true, value: await service.revoke(true, signal) };
    }
    return badRequest("unknown Antigravity auth endpoint");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    return { ok: false, error: { code: "internal", message, details: {} } };
  }
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: "bad-request", message, details: { issues: [] } } };
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isRefreshPayload(value: unknown): value is { force?: boolean } {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "force") &&
    (value.force === undefined || typeof value.force === "boolean")
  );
}

function isAcknowledgement(value: unknown): value is { acknowledge: true } {
  return isRecord(value) && Object.keys(value).length === 1 && value.acknowledge === true;
}

function isRevokePayload(value: unknown): value is { confirmed: true } {
  return isRecord(value) && Object.keys(value).length === 1 && value.confirmed === true;
}

