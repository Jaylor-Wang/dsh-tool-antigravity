/**
 * Unified DeepSeek Harness Antigravity Capability Bundle.
 *
 * Core Features:
 * 1. Google Antigravity OAuth 2.0 PKCE authentication with local loopback callback.
 * 2. LLM Provider (`google-antigravity`) with Gemini, Claude, and GPT-OSS routing.
 * 3. High-performance connection pooling, SSE streaming, and quota management.
 */

import type { Context } from "@deepseek-ai/cordis";
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
import { openPlatformBrowser } from "./utils/process-opener.js";

export const ANTIGRAVITY_PLUGIN_ID = "dsh-tool-antigravity";
export const ANTIGRAVITY_LEGACY_PLUGIN_ID = "dsh-antigravity-auth";
export const ANTIGRAVITY_PROVIDER = "google-antigravity";
export const ANTIGRAVITY_LLM_ROUTE = "google-antigravity";

export const name = "antigravity-auth";
export const inject = ["llm"] as const;

export function apply(ctx: Context): void {
  const c = ctx as any;
  const service = createAntigravityAuthService();

  const adapter = new AntigravityAdapter({
    auth: service,
    attachments: c.attachments
  });

  // 1. Register LLM Adapter
  if (c.llm?.registerAdapter) {
    const list = c.llm.listProviders?.() ?? [];
    if (!list.some((p: any) => p.id === ANTIGRAVITY_PROVIDER)) {
      c.llm.registerAdapter([ANTIGRAVITY_PROVIDER], adapter);
    }
  }

  // 2. Register Slash Command (/antigravity-auth)
  if (c.commands?.register) {
    c.commands.register({
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

  // 3. Register Loopback RPC Routes on connection if present
  if (c.connection?.fetch?.register) {
    const isLoopback =
      !c.webServer?.host ||
      c.webServer.host === "127.0.0.1" ||
      c.webServer.host === "localhost" ||
      c.webServer.host === "::1";
    const endpoints = [
      "status",
      "models",
      "usage",
      "acknowledge-risk",
      "login",
      "cancel",
      "logout",
      "revoke"
    ];

    for (const endpoint of endpoints) {
      c.connection.fetch.register({
        path: `/api/${ANTIGRAVITY_AUTH_RPC_NAMESPACE}/${endpoint}`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async ({ request }: { request: Request }) => {
          if (!isLoopback) {
            return Response.json({
              ok: false,
              error: {
                code: "loopback-required",
                message: "Antigravity Auth RPC requires loopback WebServer binding.",
                details: {}
              }
            });
          }

          try {
            const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
            switch (endpoint) {
              case "status": {
                const status = await service.status();
                return Response.json({ ok: true, value: { status } });
              }
              case "usage": {
                const force = Boolean(body.force);
                const usage = await service.usage(undefined, force);
                return Response.json({ ok: true, value: usage });
              }
              case "acknowledge-risk": {
                const ack = service.acknowledgeRisk();
                return Response.json({ ok: true, value: ack });
              }
              case "login": {
                const start = await service.startLogin();
                if (start.authorizationUrl) {
                  void openPlatformBrowser(start.authorizationUrl);
                }
                return Response.json({ ok: true, value: start });
              }
              case "cancel": {
                const cancel = await service.cancelLogin();
                return Response.json({ ok: true, value: cancel });
              }
              case "logout": {
                const logout = await service.logout();
                return Response.json({ ok: true, value: logout });
              }
              case "revoke": {
                const revoke = await service.revoke(true);
                return Response.json({ ok: true, value: revoke });
              }
              default:
                return Response.json({
                  ok: false,
                  error: { code: "not-found", message: "Endpoint not found", details: {} }
                });
            }
          } catch (error: any) {
            return Response.json({
              ok: false,
              error: {
                code: error?.code ?? "internal",
                message: error?.message ?? "Internal error",
                details: {}
              }
            });
          }
        }
      });
    }
  }
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
