import {
  getPublicModelDefinitions,
  getResolverAliasMap,
  resolveModelWithTier
} from "@cortexkit/antigravity-auth-core";
import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { isRecord } from "./safe-text.js";

export const MODEL_CATALOG_TTL_MS = 300_000; // 5 minutes
export const MAX_MODEL_CATALOG_BYTES = 262_144;

export interface CatalogModelView {
  id: string;
  name: string;
  state: "live-available" | "unavailable" | "snapshot";
}

export interface CatalogView {
  state: "snapshot" | "live-available" | "refresh-failed" | "protocol-drift";
  models: CatalogModelView[];
  checkedAt?: string;
}

export function cleanModelDisplayName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/u, "").trim();
}

export function lookupModelDefinition<T extends { id: string }>(
  definitions: Record<string, T>,
  model: string
): T | undefined {
  return (
    definitions[model] ??
    definitions[`antigravity-${model}`] ??
    definitions[model.replace(/^antigravity-/, "")]
  );
}

export function normalizeReasoningEffort(value: unknown): "low" | "medium" | "high" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

export function getModelReasoningEfforts(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes("flash") && !lower.includes("image")) {
    return {
      efforts: [
        { id: ReasoningEffortId("low"), name: "Low" },
        { id: ReasoningEffortId("medium"), name: "Medium" },
        { id: ReasoningEffortId("high"), name: "High" }
      ],
      defaultEffort: ReasoningEffortId(lower.includes("gemini-3.8-flash") ? "medium" : "high")
    };
  }
  if (lower.includes("pro")) {
    return {
      efforts: [
        { id: ReasoningEffortId("low"), name: "Low" },
        { id: ReasoningEffortId("high"), name: "High" }
      ],
      defaultEffort: ReasoningEffortId("high")
    };
  }
  return undefined;
}

export function createCatalogView(
  definitions: Record<string, { id: string; name: string; modalities: { input: string[]; output: string[] } }>,
  state: CatalogView["state"],
  available?: Set<string>,
  checkedAt?: string
): CatalogView {
  return {
    state,
    models: Object.values(definitions)
      .filter((def) => !def.modalities.output.includes("image"))
      .map((def) => ({
        id: def.id,
        name: cleanModelDisplayName(def.name),
        state: state === "live-available"
          ? available?.has(def.id)
            ? "live-available"
            : "unavailable"
          : "snapshot"
      })),
    ...checkedAt !== undefined ? { checkedAt } : {}
  };
}

export function cloneCatalogView(value: CatalogView): CatalogView {
  return {
    state: value.state,
    models: value.models.map((m) => ({ ...m })),
    ...value.checkedAt !== undefined ? { checkedAt: value.checkedAt } : {}
  };
}

export function resolveWireModel(model: string, reasoningEffort?: unknown): string {
  if (model === "antigravity-gemini-3.7-flash" || model === "gemini-3.7-flash") {
    return "gemini-3-flash";
  }
  const effort = normalizeReasoningEffort(reasoningEffort);
  const routeModel =
    effort !== undefined && (model === "antigravity-gemini-3.8-flash" || model === "gemini-3.8-flash")
      ? `${model}-${effort}`
      : model;

  const resolved = resolveModelWithTier(routeModel, { cli_first: false });
  if (resolved.actualModel.startsWith("gemini-3.7-flash")) {
    return "gemini-3-flash";
  }
  return resolved.actualModel;
}

export function parseLiveModelIds(
  value: unknown,
  _definitions: Record<string, unknown>
): Set<string> {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value;
  if (!isRecord(root) || !isRecord(root.models)) {
    throw new LlmError("The Antigravity live model catalog did not match the audited schema", "PROTOCOL_DRIFT");
  }
  const entries = Object.entries(root.models);
  if (entries.length > 512) {
    throw new LlmError("The Antigravity live model catalog exceeded the model limit", "PROTOCOL_DRIFT");
  }

  const aliases = getResolverAliasMap();
  const live = new Set<string>();

  for (const [id, rawEntry] of entries) {
    if (!safeModelId(id) || !isRecord(rawEntry)) {
      throw new LlmError("The Antigravity live model catalog did not match the audited schema", "PROTOCOL_DRIFT");
    }
    const cleanId = cleanModelId(id);
    const canonical = aliases[cleanId] ?? aliases[id] ?? cleanId;
    live.add(canonical);
    live.add(cleanId);
    live.add(id);

    if (
      cleanId === "gemini-3-flash" ||
      cleanId === "gemini-3-flash-agent" ||
      cleanId === "gemini-3.7-flash-tiered" ||
      cleanId.startsWith("gemini-3-flash") ||
      cleanId.startsWith("gemini-3.7-flash")
    ) {
      live.add("gemini-3.7-flash");
      live.add("antigravity-gemini-3.7-flash");
    }
    if (cleanId.startsWith("gemini-3.8-flash")) {
      live.add("gemini-3.8-flash");
      live.add("antigravity-gemini-3.8-flash");
    }
    if (cleanId.startsWith("gemini-3.1-pro")) {
      live.add("gemini-3.1-pro");
      live.add("antigravity-gemini-3.1-pro");
    }
    if (cleanId.includes("claude-4-6-sonnet") || cleanId.includes("claude-sonnet-4-6")) {
      live.add("claude-4-6-sonnet");
      live.add("antigravity-claude-4-6-sonnet");
    }
    if (cleanId.includes("claude-4-6-opus") || cleanId.includes("claude-opus-4-6")) {
      live.add("claude-4-6-opus");
      live.add("antigravity-claude-4-6-opus");
    }
    if (cleanId.includes("gpt-oss")) {
      live.add("gpt-oss-120b");
      live.add("antigravity-gpt-oss-120b");
    }
  }

  return live;
}

function safeModelId(id: string): boolean {
  return id.length > 0 && id.length <= 256 && /^[a-zA-Z0-9_.:/-]+$/.test(id);
}

function cleanModelId(id: string): string {
  return id.replace(/^models\//u, "").trim();
}

export { getPublicModelDefinitions };
