import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

describe("Build Artifacts Verification", () => {
  // Test case deliberately exercises runtime loading boundaries of built distribution files
  it("verifies main ESM bundle (lib/index.mjs) exports and Cordis plugin spec", async () => {
    // Intentionally testing built ESM artifact loading boundary
    const main = await import("../lib/index.mjs");

    expect(main.name).toBe("antigravity-auth");
    expect(main.inject).toEqual(["llm"]);
    expect(typeof main.apply).toBe("function");

    // Public constants
    expect(main.ANTIGRAVITY_PROVIDER).toBe("google-antigravity");
    expect(main.ANTIGRAVITY_LLM_ROUTE).toBe("google-antigravity");
    expect(main.ANTIGRAVITY_WIRE_ORIGIN).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(main.AGY_PROVIDER_USER_AGENT).toMatch(/^antigravity\/cli\/1\.1\.24/);

    // Services
    expect(typeof main.AntigravityAdapter).toBe("function");
    expect(typeof main.AntigravityAuthService).toBe("function");
    expect(typeof main.createAntigravityAuthService).toBe("function");
  });

  // Test case deliberately exercises runtime loading boundaries of built distribution files
  it("verifies image ESM bundle (lib/image.mjs) exports and Cordis plugin spec", async () => {
    // Intentionally testing built ESM artifact loading boundary
    const image = await import("../lib/image.mjs");

    expect(image.name).toBe("antigravity-image");
    expect(image.inject).toEqual(["tools", "attachments", "fs"]);
    expect(typeof image.apply).toBe("function");

    expect(image.GENERATE_IMAGE_TOOL_NAME).toBe("generate_image");
    expect(image.LIST_IMAGES_TOOL_NAME).toBe("list_images");
    expect(typeof image.createAntigravityImageTools).toBe("function");
  });

  // Test case deliberately exercises runtime loading boundaries of CommonJS distribution bundle
  it("verifies client CommonJS bundle (lib/client.cjs) exports and UI entry", () => {
    const require = createRequire(import.meta.url);
    const clientPath = path.resolve(__dirname, "../lib/client.cjs");
    const client = require(clientPath);

    expect(typeof client.apply).toBe("function");
    expect(typeof client.AntigravityAuthSettings).toBe("function");
  });

  it("verifies plugins can be loaded into Cordis Context without injection errors", async () => {
    const { Context } = await import("@deepseek-ai/cordis");
    const main = await import("../lib/index.mjs");
    const image = await import("../lib/image.mjs");

    const ctx = new Context();
    ctx.provide("llm", {
      listProviders: () => [],
      registerAdapter: () => {}
    });
    ctx.provide("tools", {
      register: () => {}
    });
    ctx.provide("attachments", {
      imageLimits: {},
      validateImage: async () => {},
      saveImage: async () => {},
      readImage: async () => {}
    });
    ctx.provide("fs", {
      resolve: async () => ({}),
      contains: () => true,
      readBytes: async () => new Uint8Array(),
      lstat: async () => ({}),
      stat: async () => ({})
    });

    await ctx.plugin(main);
    await ctx.plugin(image);

    expect(ctx.get("antigravityAuth")).toBeDefined();
    expect(typeof ctx.get("antigravityAuth").status).toBe("function");
    expect(typeof ctx.get("antigravityAuth").credential).toBe("function");
  });
});
