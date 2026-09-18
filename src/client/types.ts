import type { CredentialStatusView, RevokeState, RevokeStatusView } from "../credential-coordinator.js";
import type { QuotaStatusView } from "../quota-service.js";

export const CAPABILITY_ROW_IDS = ["auth-llm", "search", "image", "video"] as const;
export type CapabilityRowId = (typeof CAPABILITY_ROW_IDS)[number];

export const LOGIN_PHASES = [
  "idle",
  "pending",
  "success",
  "cancelled",
  "expired",
  "port-conflict",
  "failed"
] as const;
export type LoginPhase = (typeof LOGIN_PHASES)[number];

export type LoginErrorCode = string;

export interface LoginStatusView {
  readonly phase: LoginPhase;
  readonly configured: boolean;
  readonly projectAvailable: boolean;
  readonly authorizationUrl?: string;
  readonly expiresAt?: string;
  readonly errorCode?: LoginErrorCode;
}

export interface CapabilityGateStatus {
  readonly id: CapabilityRowId;
  readonly state: "available" | "disabled" | "poc-pending" | "protocol-drift";
  readonly reasonCode: string;
}

export interface AntigravityStatusView {
  readonly pluginId: "dsh-antigravity-auth";
  readonly phase: "bootstrap";
  readonly privateSelfUse: true;
  readonly singleAccount: true;
  readonly riskAcknowledgementRequired: true;
  readonly riskAcknowledged: boolean;
  readonly login: LoginStatusView;
  readonly credential?: CredentialStatusView;
  readonly revoke?: RevokeStatusView;
  readonly capabilities: readonly CapabilityGateStatus[];
}

export interface RiskAcknowledgementResult {
  readonly acknowledged: true;
}

export interface LoginStartResult {
  readonly phase: LoginPhase;
  readonly authorizationUrl?: string;
  readonly expiresAt?: string;
  readonly configured?: boolean;
}
export interface LoginActionResult {
  readonly phase: LoginPhase;
  readonly errorCode?: LoginErrorCode;
}


export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } };

export interface AntigravityAuthRpcClient {
  status(signal?: AbortSignal): Promise<RpcResult<{ status: AntigravityStatusView }>>;
  usage?(signal?: AbortSignal, force?: boolean): Promise<RpcResult<QuotaStatusView>>;
  acknowledgeRisk(signal?: AbortSignal): Promise<RpcResult<RiskAcknowledgementResult>>;
  login(signal?: AbortSignal): Promise<RpcResult<LoginStartResult>>;
  cancelLogin(signal?: AbortSignal): Promise<RpcResult<{ readonly phase: LoginPhase; readonly errorCode?: LoginErrorCode }>>;
  logout(signal?: AbortSignal): Promise<RpcResult<{ readonly state: "logged-out" }>>;
  revoke?(confirmed: boolean, signal?: AbortSignal): Promise<RpcResult<{ readonly state: RevokeState }>>;
}
