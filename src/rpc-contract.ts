/** Browser-safe RPC contract for the Antigravity login flow. */

import type { ConnectionRpcResult as RpcResult } from "@deepseek-ai/dsh-client-connection/client";
import type {
  AntigravityAuthRpcClient,
  AntigravityStatusView,
  CapabilityGateStatus,
  CapabilityRowId,
  LoginActionResult,
  LoginErrorCode,
  LoginPhase,
  LoginStartResult,
  LoginStatusView,
  RiskAcknowledgementResult
} from "./client/types.js";
import type { QuotaStatusView } from "./quota-service.js";

export const ANTIGRAVITY_AUTH_RPC_CHANNEL = "/api";
export const ANTIGRAVITY_AUTH_RPC_NAMESPACE = "antigravity-auth" as const;

export type {
  AntigravityAuthRpcClient,
  AntigravityStatusView,
  CapabilityGateStatus,
  CapabilityRowId,
  LoginActionResult,
  LoginErrorCode,
  LoginPhase,
  LoginStartResult,
  LoginStatusView,
  RiskAcknowledgementResult
};

export interface AntigravityAuthConnectionRpc {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<RpcResult<unknown>>;
}

export function createAntigravityAuthRpcClient(rpc: AntigravityAuthConnectionRpc): AntigravityAuthRpcClient {
  return {
    status: (signal) =>
      callValidated(rpc, "status", {}, signal, parseStatusResult),
    acknowledgeRisk: (signal) =>
      callValidated(rpc, "acknowledge-risk", { acknowledge: true }, signal, parseAcknowledgementResult),
    login: (signal) => callValidated(rpc, "login", {}, signal, parseLoginResult),
    cancelLogin: (signal) => callValidated(rpc, "cancel", {}, signal, parseActionResult),
    logout: (signal) => callValidated(rpc, "logout", {}, signal, parseLogoutResult),
    revoke: (confirmed, signal) => callValidated(rpc, "revoke", { confirmed }, signal, parseRevokeResult),
    usage: (signal, force = false) =>
      callValidated(rpc, "usage", { force }, signal, parseUsageResult)
  };
}

async function callValidated<T>(
  rpc: AntigravityAuthConnectionRpc,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal | undefined,
  parse: (value: unknown) => T | undefined
): Promise<RpcResult<T>> {
  let result: RpcResult<unknown>;
  try {
    result = await rpc.call(
      ANTIGRAVITY_AUTH_RPC_CHANNEL,
      `${ANTIGRAVITY_AUTH_RPC_NAMESPACE}/${endpoint}`,
      payload,
      signal
    );
  } catch {
    return invalidResponse(endpoint);
  }
  if (!result.ok) return result as RpcResult<never>;
  const value = parse(result.value);
  return value === undefined ? invalidResponse(endpoint) : { ok: true, value };
}

export function parseUsageResult(value: unknown): QuotaStatusView | undefined {
  if (!isRecord(value) || typeof value.state !== "string") return undefined;
  return value as unknown as QuotaStatusView;
}

export function parseStatusResult(value: unknown): { status: AntigravityStatusView } | undefined {
  if (!isRecord(value) || !("status" in value)) return undefined;
  return { status: value.status as AntigravityStatusView };
}

function parseAcknowledgementResult(value: unknown): RiskAcknowledgementResult | undefined {
  return isRecord(value) && value.acknowledged === true ? { acknowledged: true } : undefined;
}

function parseLoginResult(value: unknown): LoginStartResult | undefined {
  if (!isRecord(value) || typeof value.phase !== "string") return undefined;
  return value as unknown as LoginStartResult;
}

function parseActionResult(value: unknown): LoginActionResult | undefined {
  if (!isRecord(value) || typeof value.phase !== "string") return undefined;
  return value as unknown as LoginActionResult;
}

function parseLogoutResult(value: unknown): { readonly state: "logged-out" } | undefined {
  return isRecord(value) && value.state === "logged-out" ? { state: "logged-out" } : undefined;
}

function parseRevokeResult(value: unknown): { readonly state: any } | undefined {
  if (!isRecord(value) || typeof value.state !== "string") return undefined;
  return { state: value.state };
}

function invalidResponse(endpoint: string): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: "internal",
      message: `antigravity-auth: invalid ${endpoint} response from Host`,
      details: {}
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
