/**
 * Unified DeepSeek Harness Antigravity Capability Bundle.
 *
 * Core Features:
 * 1. Google Antigravity OAuth 2.0 PKCE authentication with local loopback callback.
 * 2. LLM Provider (`google-antigravity`) with Gemini, Claude, and GPT-OSS routing.
 * 3. High-performance connection pooling, SSE streaming, and quota management.
 */

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-host-webserver";
import { AntigravityAdapter } from "./llm-adapter.js";
import { AntigravityAuthService, createAntigravityAuthService } from "./auth-service.js";
import { CredentialOperationError, ANTIGRAVITY_TOKEN_ENDPOINT, ANTIGRAVITY_REVOKE_ENDPOINT } from "./credential-coordinator.js";
import { OAuthFlowError } from "./oauth-flow.js";
import {
  AGY_PROVIDER_USER_AGENT,
  ANTIGRAVITY_WIRE_ORIGIN,
  ANTIGRAVITY_WIRE_ORIGINS,
  ANTIGRAVITY_WIRE_PATHS
} from "./wire-identity.js";
import {
  ANTIGRAVITY_AUTH_RPC_CHANNEL,
  ANTIGRAVITY_AUTH_RPC_NAMESPACE,
  createAntigravityAuthRpcClient
} from "./rpc-contract.js";
import { registerAccountRoutes } from "./account-routes.js";
import { createLoopbackRpcGuard } from "./loopback-rpc.js";
import { ANTIGRAVITY_AUTH_RPC_ENDPOINTS, handleAntigravityAuthRpc } from "./rpc.js";
import { openPlatformBrowser } from "./utils/process-opener.js";


export const ANTIGRAVITY_PLUGIN_ID = "dsh-tool-antigravity";
export const ANTIGRAVITY_LEGACY_PLUGIN_ID = "dsh-antigravity-auth";
export const ANTIGRAVITY_PROVIDER = "google-antigravity";
export const ANTIGRAVITY_LLM_ROUTE = "google-antigravity";

export const name = "antigravity-auth";
export const inject = ["llm"] as const;
export const provide = ["antigravityAuth"] as const;

export function apply(ctx: Context): void {
  const service = createAntigravityAuthService();
  ctx.provide("antigravityAuth", service);

  const attachments = ctx.get("attachments");

  const adapter = new AntigravityAdapter({
    auth: service,
    attachments
  });

  // 1. Register LLM Adapter
  const llm = ctx.get("llm") ?? (ctx as any).llm;
  if (llm?.registerAdapter) {
    const list = llm.listProviders?.() ?? [];
    if (!list.some((p: any) => p.id === ANTIGRAVITY_PROVIDER)) {
      llm.registerAdapter([ANTIGRAVITY_PROVIDER], adapter);
    }
  }

  // 2. Register Slash Command (/antigravity-auth)
  const commands = ctx.get("commands");
  if (commands?.register) {
    commands.register({
      name: "antigravity-auth",
      description: "Manage Antigravity authentication, status, and quota",
      handler: async ({ rawInput }: { rawInput: string }) => {
        const op = rawInput.trim().toLowerCase();
        if (!op || op === "status") {
          const status = await service.status();
          return {
            kind: "success",
            text: `Antigravity Auth Status: phase=${status.login.phase}, configured=${status.login.configured}`
          };
        }
        if (op === "login") {
          const result = await service.startLogin();
          if (result.authorizationUrl) {
            void openPlatformBrowser(result.authorizationUrl);
            return {
              kind: "success",
              text: "Opened browser for Google Antigravity sign-in. Waiting for callback..."
            };
          }
          return { kind: "error", text: "Failed to initiate Antigravity login." };
        }
        if (op === "cancel") {
          const res = await service.cancelLogin();
          return { kind: "success", text: `Cancelled login: phase=${res.phase}` };
        }
        if (op === "logout") {
          await service.logout();
          return { kind: "success", text: "Logged out from Antigravity." };
        }
        return {
          kind: "error",
          text: `Unknown command "${op}". Available: status, login, cancel, logout`
        };
      }
    });
  }

  // 3. Register Loopback RPC Routes once Connection is available.
  ctx.inject(["connection"], (connectionCtx) => {
    const webServer = connectionCtx.get("webServer") as { host?: string } | undefined;
    const guard = createLoopbackRpcGuard(webServer?.host, (endpoint, payload, signal) =>
      handleAntigravityAuthRpc(service, endpoint, payload, signal)
    );
    if (guard.mode === "blocked") {
      connectionCtx.logger.warn("antigravity-auth: account RPC is disabled because the WebServer is not loopback-bound");
    }
    return registerAccountRoutes(
      connectionCtx.connection,
      ANTIGRAVITY_AUTH_RPC_NAMESPACE,
      ANTIGRAVITY_AUTH_RPC_ENDPOINTS,
      guard.handler
    );
  });
}

export {
  AntigravityAdapter,
  AntigravityAuthService,
  createAntigravityAuthService,
  CredentialOperationError,
  OAuthFlowError,
  AGY_PROVIDER_USER_AGENT,
  ANTIGRAVITY_TOKEN_ENDPOINT,
  ANTIGRAVITY_REVOKE_ENDPOINT,
  ANTIGRAVITY_WIRE_ORIGIN,
  ANTIGRAVITY_WIRE_ORIGINS,
  ANTIGRAVITY_WIRE_PATHS,
  ANTIGRAVITY_AUTH_RPC_CHANNEL,
  ANTIGRAVITY_AUTH_RPC_NAMESPACE,
  createAntigravityAuthRpcClient
};
