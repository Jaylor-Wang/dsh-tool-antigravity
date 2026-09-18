/**
 * Antigravity Image Plugin for DeepSeek Harness (Cordis lifecycle).
 */

import type { Context } from "@deepseek-ai/cordis";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import type ToolRuntime from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
  ANTIGRAVITY_IMAGE_ENDPOINT,
  ANTIGRAVITY_IMAGE_MODEL,
  AntigravityImageError,
  createAntigravityImageTools,
  GENERATE_IMAGE_TOOL_NAME,
  LIST_IMAGES_TOOL_NAME,
  type AntigravityImageSettings,
  type ImageToolsCredential
} from "./image-tool.js";

export const name = "antigravity-image";
export const inject = ["tools", "attachments", "fs"] as const;

export const ANTIGRAVITY_IMAGE_SETTINGS_NAMESPACE = "antigravity-image";

export const Config = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default(ANTIGRAVITY_IMAGE_MODEL),
  n: z.number().step(1).min(1).max(4).default(1)
});

export interface ImagePluginContext extends Context {
  tools: ToolRuntime;
  attachments: AttachmentStore;
  fs: FileSystem;
  antigravityAuth?: {
    credential(signal?: AbortSignal): Promise<ImageToolsCredential | undefined>;
    status?(): Promise<unknown>;
  };
}

export function apply(
  ctx: ImagePluginContext,
  config: AntigravityImageSettings = {
    enabled: true,
    model: ANTIGRAVITY_IMAGE_MODEL,
    n: 1
  }
): void {
  const toolsRuntime = ctx.get("tools") ?? ctx.tools;
  const attachments = ctx.get("attachments") ?? ctx.attachments;
  const fs = ctx.get("fs") ?? ctx.fs;
  if (!toolsRuntime || !attachments || !fs) return;

  const auth = (ctx.get("antigravityAuth") as ImagePluginContext["antigravityAuth"]) ?? {
    credential: async () => undefined
  };

  const tools = createAntigravityImageTools({
    auth,
    attachments,
    fs,
    settings: () => config
  });

  if (config.enabled) {
    for (const tool of tools) {
      toolsRuntime.register(tool);
    }
  }
}

export {
  ANTIGRAVITY_IMAGE_ENDPOINT,
  ANTIGRAVITY_IMAGE_MODEL,
  AntigravityImageError,
  createAntigravityImageTools,
  GENERATE_IMAGE_TOOL_NAME,
  LIST_IMAGES_TOOL_NAME
};
export type { AntigravityImageSettings };
