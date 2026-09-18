import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import type { ConnectionRpcHandler, HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import {
  buildWireIdentityHeaders,
  createWireIdentity,
  assertWireIdentityInvariant,
  DSH_ATTRIBUTION_HEADER,
  AGY_PROVIDER_USER_AGENT
} from "../src/wire-identity.js";
import { TlsSocketPool } from "../src/socket-pool.js";
import { createAuthStore, AUTH_STORE_LOCK_NAME } from "../src/credential-store.js";
import { normalizeProjectId } from "../src/project-context.js";
import { createAntigravityAuthRpcClient, type AntigravityAuthConnectionRpc } from "../src/rpc-contract.js";
import { registerAccountRoutes } from "../src/account-routes.js";
import { createLoopbackRpcGuard } from "../src/loopback-rpc.js";
import { handleAntigravityAuthRpc } from "../src/rpc.js";
import { createAntigravityAuthService } from "../src/auth-service.js";
import * as main from "../src/index.js";

describe("Wire Identity", () => {
  it("generates exact audited provider headers with truthful DSH attribution", () => {
    const headers = buildWireIdentityHeaders();
    expect(headers["User-Agent"]).toBe(AGY_PROVIDER_USER_AGENT);
    expect(headers[DSH_ATTRIBUTION_HEADER]).toBeDefined();
    expect(() => assertWireIdentityInvariant(headers)).not.toThrow();
  });

  it("serializes HTTP/1.1 payload with CRLF boundaries and allowlisted endpoint", () => {
    const wire = createWireIdentity();
    const endpoint = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
    const serialized = wire.serialize(endpoint, {
      authorization: "Bearer ya29.test_token",
      body: JSON.stringify({ test: true })
    });

    const text = serialized.toString("utf8");
    expect(text).toContain("POST /v1internal:loadCodeAssist HTTP/1.1\r\n");
    expect(text).toContain("Authorization: Bearer ya29.test_token\r\n");
    expect(text).toContain(`User-Agent: ${AGY_PROVIDER_USER_AGENT}\r\n`);
    expect(text).toContain(`${DSH_ATTRIBUTION_HEADER}: `);
    expect(text).toContain('{"test":true}');
  });
});

describe("TLS Socket Pool & Session Ticket Cache", () => {
  it("stores and retrieves TLS session tickets with TTL", () => {
    const pool = new TlsSocketPool({ sessionCacheTtlMs: 10_000 });
    const origin = "https://daily-cloudcode-pa.googleapis.com:443";
    const ticket = Buffer.from("mock_tls_session_ticket_001");

    expect(pool.getSessionTicket(origin)).toBeUndefined();
    pool.setSessionTicket(origin, ticket);

    const retrieved = pool.getSessionTicket(origin);
    expect(retrieved).toBeDefined();
    expect(retrieved?.toString()).toBe("mock_tls_session_ticket_001");

    pool.destroy();
    expect(pool.getSessionTicket(origin)).toBeUndefined();
  });
});

describe("Credential Store & Windows Lock Active PID Recovery", () => {
  it("commits and reads credentials atomically", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-auth-test-"));
    const storePath = path.join(tmpDir, "auth.json");

    try {
      const store = createAuthStore(storePath);
      expect(await store.read()).toBeUndefined();

      const committed = await store.commit({
        refreshToken: "1//test_refresh_token",
        projectId: "my-test-project",
        email: "developer@example.com"
      });

      expect(committed.revision).toBe(1);
      expect(committed.refreshToken).toBe("1//test_refresh_token");
      expect(committed.projectId).toBe("my-test-project");

      const readBack = await store.read();
      expect(readBack).toBeDefined();
      expect(readBack?.revision).toBe(1);
      expect(readBack?.projectId).toBe("my-test-project");

      // Compare and commit with matching revision succeeds
      const updated = await store.compareAndCommit(1, {
        refreshToken: "1//test_refresh_token_v2",
        projectId: "my-test-project",
        lineage: committed.lineage
      }, committed.lineage);
      expect(updated?.revision).toBe(2);
      expect(updated?.refreshToken).toBe("1//test_refresh_token_v2");

      // Stale revision fails
      const stale = await store.compareAndCommit(1, {
        refreshToken: "1//stale_token",
        projectId: "my-test-project",
        lineage: committed.lineage
      }, committed.lineage);
      expect(stale).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("instantly recovers from stale locks left by terminated dead processes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-lock-test-"));
    const storePath = path.join(tmpDir, "auth.json");
    const lockPath = path.join(tmpDir, AUTH_STORE_LOCK_NAME);

    try {
      // Simulate a crashed process that wrote a non-existent PID (e.g. 99999999) into .auth.lock
      const deadPid = 99_999_999;
      await fs.writeFile(lockPath, `${deadPid}\n`, "utf8");

      const store = createAuthStore(storePath);

      // The new store operation should detect that PID 99999999 is dead and reclaim the lock immediately
      // without waiting for the 30-second stale timeout
      const startTime = Date.now();
      const committed = await store.commit({
        refreshToken: "1//recovered_token",
        projectId: "recovered-project"
      });
      const elapsed = Date.now() - startTime;

      expect(committed.projectId).toBe("recovered-project");
      // Instant recovery should take well under 2 seconds, not 30 seconds!
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("Project Discovery Normalization", () => {
  it("normalizes valid Google Cloud project IDs and rejects invalid shapes", () => {
    expect(normalizeProjectId("my-cloud-project-123")).toBe("my-cloud-project-123");
    expect(normalizeProjectId("  leading-and-trailing  ")).toBe("leading-and-trailing");
    expect(normalizeProjectId("123-invalid-start-with-number")).toBeUndefined();
    expect(normalizeProjectId("")).toBeUndefined();
    expect(normalizeProjectId(null)).toBeUndefined();
  });
});

describe("RPC Contract & Client Connection Protocol", () => {
  it("adapts connection.rpc to AntigravityAuthRpcClient and calls status endpoint", async () => {
    const recordedCalls: Array<{ channel: string; endpoint: string; payload: unknown }> = [];
    const mockConnectionRpc: AntigravityAuthConnectionRpc = {
      call: async (channel, endpoint, payload) => {
        recordedCalls.push({ channel, endpoint, payload });
        if (endpoint === "antigravity-auth/status") {
          return {
            ok: true,
            value: {
              status: {
                riskAcknowledged: true,
                login: { phase: "idle", configured: false, projectAvailable: false },
                credential: { configured: false },
                capabilities: []
              }
            }
          };
        }
        return { ok: false, error: { code: "not-found", message: "Not found", details: {} } };
      }
    };

    const client = createAntigravityAuthRpcClient(mockConnectionRpc);
    expect(typeof client.status).toBe("function");
    expect(typeof client.login).toBe("function");

    const result = await client.status();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status.login.phase).toBe("idle");
    }
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0]?.channel).toBe("/api");
    expect(recordedCalls[0]?.endpoint).toBe("antigravity-auth/status");
  });
});

describe("Host account RPC routes", () => {
  it("registers exact /api routes after connection inject and returns a server-response envelope", async () => {
    const registered: Array<{ path: string; methods: readonly string[] }> = [];
    const fetchers = new Map<string, (request: Request) => Promise<Response>>();
    const connection = {
      fetch: {
        register: (route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }) => {
          registered.push({ path: route.path, methods: route.methods });
          fetchers.set(route.path, route.fetch);
          return async () => {
            fetchers.delete(route.path);
          };
        }
      }
    } as unknown as HostConnectionHandle;
    const service = createAntigravityAuthService();
    const handler: ConnectionRpcHandler = (endpoint, payload, signal) =>
      handleAntigravityAuthRpc(service, endpoint, payload, signal);
    const dispose = registerAccountRoutes(
      connection,
      "antigravity-auth",
      ["status", "usage"],
      createLoopbackRpcGuard("127.0.0.1", handler).handler
    );

    expect(registered.map((route) => route.path)).toEqual([
      "/api/antigravity-auth/status",
      "/api/antigravity-auth/usage"
    ]);

    const rpcId = "account-status-test";
    const response = await fetchers.get("/api/antigravity-auth/status")!(
      new Request("http://127.0.0.1/api/antigravity-auth/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId,
          method: "antigravity-auth/status",
          payload: {}
        })
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      type: "server-response",
      rpcId,
      result: { ok: true }
    });
    expect(body.result.value.status.login.phase).toBeDefined();

    const usage = await fetchers.get("/api/antigravity-auth/usage")!(
      new Request("http://127.0.0.1/api/antigravity-auth/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "account-usage-test",
          method: "antigravity-auth/usage",
          payload: { force: false }
        })
      })
    );
    const usageBody = await usage.json();
    expect(usageBody.result.ok).toBe(true);
    expect(typeof usageBody.result.value.state).toBe("string");

    await dispose();
    expect(fetchers.size).toBe(0);
  });

  it("defers Host route registration until connection is injected", async () => {
    const ctx = new Context();
    const registered: string[] = [];
    ctx.provide("llm", {
      listProviders: () => [],
      registerAdapter: () => {}
    });
    await ctx.plugin({
      name: main.name,
      inject: [...main.inject],
      provide: [...main.provide],
      apply: main.apply
    });
    expect(registered).toEqual([]);

    ctx.provide("connection", {
      fetch: {
        register: (route: { path: string }) => {
          registered.push(route.path);
          return async () => {};
        }
      }
    });
    ctx.provide("webServer", { host: "127.0.0.1" });
    await ctx.fiber.await();
    expect(registered).toContain("/api/antigravity-auth/status");
    expect(registered).toContain("/api/antigravity-auth/usage");
    await ctx.fiber.dispose();
  });
});


