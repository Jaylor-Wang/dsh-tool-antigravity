/** Static fail-closed guard for account RPC after DSH removed per-channel authority. */

import type { ConnectionRpcHandler, ConnectionRpcResult } from "@deepseek-ai/dsh-client-connection";

export type LoopbackRpcMode = "enabled" | "blocked";

export interface LoopbackRpcGuard {
  readonly mode: LoopbackRpcMode;
  readonly handler: ConnectionRpcHandler;
}

export const LOOPBACK_REQUIRED_MESSAGE = "Antigravity account controls require a loopback-bound DSH Host";

export function loopbackMode(webServerHost: string | undefined): LoopbackRpcMode {
  return webServerHost === "127.0.0.1" ? "enabled" : "blocked";
}

export function createLoopbackRpcGuard(
  webServerHost: string | undefined,
  delegate: ConnectionRpcHandler
): LoopbackRpcGuard {
  if (loopbackMode(webServerHost) === "blocked") {
    return {
      mode: "blocked",
      handler: async (): Promise<ConnectionRpcResult<never>> => ({
        ok: false,
        error: {
          code: "loopback-required",
          message: LOOPBACK_REQUIRED_MESSAGE,
          details: {}
        }
      })
    };
  }
  return { mode: "enabled", handler: delegate };
}
