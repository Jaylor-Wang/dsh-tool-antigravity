import {
  CLAUDE_DESCRIPTION_PROMPT,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION
} from "@cortexkit/antigravity-auth-core";
import { isRecord } from "./safe-text.js";

export const ANTIGRAVITY_REPLAY_VERSION = 1;
const MAX_SIGNATURE_LENGTH = 16384;
const MAX_BLOCKS = 128;

export type ModelFamily = "gemini" | "claude" | "gpt-oss" | "unknown";

export interface ReplayBlock {
  kind: string;
  signature?: string;
}

export interface ReplayState {
  response: {
    version: 1;
    provider: "google-antigravity";
    model: string;
    family: ModelFamily;
    finish?: string;
  };
  blocks: ReplayBlock[];
}

export function antigravityModelFamily(model: string): ModelFamily {
  const value = model.toLowerCase();
  if (value.includes("gemini")) return "gemini";
  if (value.includes("claude")) return "claude";
  if (value.includes("gpt-oss")) return "gpt-oss";
  return "unknown";
}

function safeSignature(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SIGNATURE_LENGTH) {
    return undefined;
  }
  return value;
}

function safeFinish(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return undefined;
  }
  const normalized = value.toUpperCase();
  const allowed = ["STOP", "MAX_TOKENS", "LENGTH", "TOOL_CALLS", "FUNCTION_CALL", "CONTENT_FILTER"];
  return allowed.includes(normalized) ? normalized : undefined;
}

export function createReplayState(
  model: string,
  family: ModelFamily,
  finish: string | undefined,
  blocks: { kind: string; signature?: string }[]
): ReplayState {
  const boundedBlocks: ReplayBlock[] = blocks.slice(0, MAX_BLOCKS).map((block) => {
    const signature = safeSignature(block.signature);
    return {
      kind: block.kind,
      ...signature !== undefined ? { signature } : {}
    };
  });
  const boundedFinish = safeFinish(finish);
  return {
    response: {
      version: 1,
      provider: "google-antigravity",
      model: model.slice(0, 256),
      family,
      ...boundedFinish !== undefined ? { finish: boundedFinish } : {}
    },
    blocks: boundedBlocks
  };
}

export function compatibleReplayState(
  message: { role: string; content: unknown[]; source?: unknown; replayState?: unknown },
  provider: string,
  model: string,
  blockKinds?: string[]
): ReplayState | undefined {
  if (provider !== "google-antigravity" || message.role !== "assistant") {
    return undefined;
  }
  const provenance = isRecord(message.source) ? message.source : undefined;
  if (
    provenance !== undefined &&
    provenance.kind === "model" &&
    (provenance.provider !== provider || provenance.model !== model)
  ) {
    return undefined;
  }
  const value = isRecord(provenance?.replayState)
    ? provenance.replayState
    : isRecord(message.replayState)
      ? message.replayState
      : undefined;

  if (!isRecord(value) || !isRecord(value.response) || !Array.isArray(value.blocks)) {
    return undefined;
  }
  const family = value.response.family as ModelFamily;
  if (
    value.response.version !== 1 ||
    value.response.provider !== provider ||
    value.response.model !== model ||
    value.blocks.length > MAX_BLOCKS
  ) {
    return undefined;
  }

  const blocks: ReplayBlock[] = [];
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.kind !== "string") continue;
    const kind = item.kind;
    const signature = typeof item.signature === "string" ? safeSignature(item.signature) : undefined;
    blocks.push({
      kind,
      ...signature !== undefined ? { signature } : {}
    });
  }

  if (
    blockKinds !== undefined &&
    (blocks.length !== blockKinds.length || blocks.some((b, i) => b.kind !== blockKinds[i]))
  ) {
    return undefined;
  }

  const finish = value.response.finish === undefined ? undefined : safeFinish(value.response.finish);
  return {
    response: {
      version: 1,
      provider: "google-antigravity",
      model,
      family,
      ...finish !== undefined ? { finish } : {}
    },
    blocks
  };
}

export function buildFunctionDeclarations(tools?: Array<{ name: string; description?: string; parameters?: unknown }>) {
  if (!tools || tools.length === 0) return [];
  return tools.slice(0, 64).map((tool) => ({
    name: tool.name.slice(0, 128),
    description: typeof tool.description === "string" ? tool.description.slice(0, 4096) : "",
    parameters: sanitizeSchema(tool.parameters)
  }));
}

function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8 || !isRecord(value)) {
    return { type: "object", properties: {} };
  }
  const allowedTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
  const type = typeof value.type === "string" && allowedTypes.includes(value.type) ? value.type : "object";
  const output: Record<string, unknown> = { type };

  if (typeof value.description === "string") {
    output.description = value.description.slice(0, 1024);
  }
  if (Array.isArray(value.required)) {
    output.required = value.required.filter((item): item is string => typeof item === "string").slice(0, 128);
  }
  if (Array.isArray(value.enum)) {
    output.enum = value.enum.slice(0, 128).filter(
      (item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null
    );
  }
  if (type === "object" && isRecord(value.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value.properties).slice(0, 128)) {
      if (key.length > 0 && !hasControl(key)) {
        properties[key.slice(0, 128)] = sanitizeSchema(item, depth + 1);
      }
    }
    output.properties = properties;
  }
  if (type === "array") {
    output.items = sanitizeSchema(value.items, depth + 1);
  }
  return output;
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function groupClaudeFunctionResponses(
  contents: Array<{ role: string; parts: unknown[] }>,
  model: string
): Array<{ role: string; parts: unknown[] }> {
  if (antigravityModelFamily(model) !== "claude") return contents;

  const grouped: Array<{ role: string; parts: unknown[] }> = [];
  let pendingResponses: unknown[] = [];

  const flushResponses = () => {
    if (pendingResponses.length === 0) return;
    grouped.push({
      role: "user",
      parts: pendingResponses
    });
    pendingResponses = [];
  };

  for (const content of contents) {
    const rawParts = Array.isArray(content.parts) ? content.parts : [];
    const responseParts = rawParts.filter((part) => isRecord(part) && isRecord(part.functionResponse));

    if (content.role === "user" && rawParts.length > 0 && responseParts.length === rawParts.length) {
      pendingResponses.push(...responseParts);
      continue;
    }

    flushResponses();
    grouped.push(content);
  }
  flushResponses();
  return grouped;
}

export function applyClaudeToolHardening(request: Record<string, unknown>): void {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return;

  request.tools = request.tools.map((tool) => {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return tool;
    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map((declaration) =>
        hardenClaudeToolDeclaration(declaration)
      )
    };
  });

  const instructionPart = { text: CLAUDE_TOOL_SYSTEM_INSTRUCTION };
  const existing = request.systemInstruction;
  if (isRecord(existing) && Array.isArray(existing.parts)) {
    if (
      existing.parts.some(
        (part) => isRecord(part) && typeof part.text === "string" && part.text.includes("CRITICAL TOOL USAGE INSTRUCTIONS")
      )
    ) {
      return;
    }
    request.systemInstruction = {
      ...existing,
      parts: [...existing.parts, instructionPart]
    };
  } else if (typeof existing === "string") {
    request.systemInstruction = {
      role: "user",
      parts: [{ text: existing }, instructionPart]
    };
  } else {
    request.systemInstruction = {
      role: "user",
      parts: [instructionPart]
    };
  }
}

function hardenClaudeToolDeclaration(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const description = typeof value.description === "string" ? value.description : "";
  if (description.includes("STRICT PARAMETERS:")) return value;

  const schema = isRecord(value.parameters) ? value.parameters : undefined;
  const properties = schema !== undefined && isRecord(schema.properties) ? schema.properties : undefined;
  if (properties === undefined || Object.keys(properties).length === 0) return value;

  const required = new Set(
    Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
  );
  const parameters = Object.entries(properties).map(([name, property]) => {
    const requiredHint = required.has(name) ? ", REQUIRED" : "";
    return `${name} (${claudeToolTypeHint(property)}${requiredHint})`;
  });

  return {
    ...value,
    description: description + CLAUDE_DESCRIPTION_PROMPT.replace("{params}", parameters.join(", "))
  };
}

function claudeToolTypeHint(value: unknown): string {
  if (!isRecord(value)) return "unknown";
  if (Array.isArray(value.enum)) {
    return value.enum.length <= 5
      ? `string ENUM[${value.enum.map((item) => JSON.stringify(item)).join(", ")}]`
      : `string ENUM[${value.enum.length} options]`;
  }
  const type = typeof value.type === "string" ? value.type : "unknown";
  if (type === "array") {
    if (!isRecord(value.items)) return "ARRAY";
    const itemType = typeof value.items.type === "string" ? value.items.type : "unknown";
    if (itemType !== "object") return `ARRAY_OF_${itemType.toUpperCase()}`;
    if (!isRecord(value.items.properties)) return "ARRAY_OF_OBJECTS";
    const nestedRequired = new Set(
      Array.isArray(value.items.required)
        ? value.items.required.filter((item): item is string => typeof item === "string")
        : []
    );
    return `ARRAY_OF_OBJECTS[${Object.entries(value.items.properties)
      .map(([name, property]) => {
        return `${name}: ${isRecord(property) && typeof property.type === "string" ? property.type : "unknown"}${
          nestedRequired.has(name) ? " REQUIRED" : ""
        }`;
      })
      .join(", ")}]`;
  }
  if (type === "object" && isRecord(value.properties)) {
    const nestedRequired = new Set(
      Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string") : []
    );
    return `object{${Object.entries(value.properties)
      .map(([name, property]) => {
        return `${name}: ${isRecord(property) && typeof property.type === "string" ? property.type : "unknown"}${
          nestedRequired.has(name) ? " REQUIRED" : ""
        }`;
      })
      .join(", ")}}`;
  }
  return type;
}
