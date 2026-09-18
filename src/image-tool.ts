/**
 * Antigravity image generation and editing tools (`generate_image` & `list_images`).
 *
 * Implements session and workspace image admission, inline data conversion,
 * Antigravity API dispatch, and durable attachment persistence.
 */
import { Buffer } from "node:buffer";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AttachmentStore, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { HarnessError, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { resolveModelWithTier } from "@cortexkit/antigravity-auth-core";
import {
  admitBase64Image,
  admitSessionImage,
  admitWorkspaceImage,
  imageHandle,
  sessionImageCatalog,
  IMAGE_HANDLE_PATTERN
} from "./media-admission.js";
import { classifyPrivateFailure } from "./private-failure.js";
import {
  createPrivateTransport,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  privateStatusError,
  PrivateTransportError,
  readPrivateText,
  type PrivateTransport
} from "./private-transport.js";
import { isRecord } from "./safe-text.js";
import { ANTIGRAVITY_WIRE_ORIGIN } from "./wire-identity.js";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
export const LIST_IMAGES_TOOL_NAME = "list_images";
export const ANTIGRAVITY_IMAGE_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:generateContent`;
export const ANTIGRAVITY_IMAGE_MODEL = "antigravity-gemini-3.1-flash-image";

export const MAX_REFERENCES = 5;
export const MAX_IMAGES = 4;
export const IMAGE_ORIGINS = ["all", "generated", "reference", "user"] as const;
export type ImageOrigin = (typeof IMAGE_ORIGINS)[number];

export class AntigravityImageError extends HarnessError {
  constructor(message: string, code: string, options: { cause?: unknown } = {}) {
    super(message, code, options);
  }
}

export interface AntigravityImageSettings {
  enabled: boolean;
  model?: string;
  n?: number;
}
export interface ImageToolsCredential {
  readonly accessToken: string;
  readonly projectId?: string;
}

export interface ImageToolsOptions {
  readonly auth: {
    credential(signal?: AbortSignal): Promise<ImageToolsCredential | undefined>;
  };
  readonly transport?: PrivateTransport;
  readonly attachments: Pick<
    AttachmentStore,
    "imageLimits" | "validateImage" | "saveImage" | "readImage"
  >;
  readonly fs: Pick<FileSystem, "resolve" | "contains" | "readBytes" | "lstat" | "stat">;
  readonly settings?: () => {
    enabled?: boolean;
    model?: string;
    n?: number;
  };
}

export interface ImageReferenceInput {
  readonly kind: "session" | "workspace";
  readonly handle?: string;
  readonly path?: string;
}

export interface GenerateImageArgs {
  readonly prompt: string;
  readonly references: readonly ImageReferenceInput[];
  readonly model: string;
  readonly n: number;
}

export interface ListImagesArgs {
  readonly limit: number;
  readonly cursor?: string;
  readonly origin: ImageOrigin;
}

export interface ImageItemResult {
  readonly handle: string;
  readonly attachment: ImageAttachmentRef;
  readonly origin: string;
  readonly seq: number;
}

export interface GenerateImageResult {
  readonly operation: "generate" | "edit";
  readonly images: readonly ImageItemResult[];
  readonly references: readonly ImageItemResult[];
  readonly warnings: readonly { index: number; code: string }[];
}

export interface ListImagesResult {
  readonly items: readonly ImageItemResult[];
  readonly nextCursor?: string;
}

const generateSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["generate", "edit"] },
    images: { type: "array", items: { type: "object", additionalProperties: true } },
    references: { type: "array", items: { type: "object", additionalProperties: true } },
    warnings: { type: "array", items: { type: "object", additionalProperties: true } }
  },
  required: ["operation", "images", "references", "warnings"],
  additionalProperties: false
} as const;

const listSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "object", additionalProperties: true } },
    nextCursor: { type: "string" }
  },
  required: ["items"],
  additionalProperties: false
} as const;

export function createAntigravityImageTools(options: ImageToolsOptions): ToolDefinition[] {
  const fixedOptions: ImageToolsOptions = {
    ...options,
    transport: options.transport ?? createPrivateTransport()
  };
  return [createGenerateTool(fixedOptions), createListTool(fixedOptions)];
}

export function createGenerateTool(options: ImageToolsOptions): ToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: "Generate or edit bounded Antigravity images and return durable session image handles.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 16384,
          description: "Description of the image to generate or edits to make."
        },
        references: {
          type: "array",
          maxItems: MAX_REFERENCES,
          description: "Optional reference images from workspace paths or session handles.",
          items: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "session" },
                  handle: { type: "string" }
                },
                required: ["kind", "handle"],
                additionalProperties: false
              },
              {
                type: "object",
                properties: {
                  kind: { const: "workspace" },
                  path: { type: "string" }
                },
                required: ["kind", "path"],
                additionalProperties: false
              }
            ]
          }
        },
        model: {
          type: "string",
          description: "Image generation model (defaults to gemini-3.1-flash-image)."
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: MAX_IMAGES,
          description: "Number of images to generate (1-4)."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    output: {
      schema: generateSchema as unknown as Record<string, unknown>,
      render: (_args, value): ContentBlock[] => renderGenerate(value as unknown as GenerateImageResult),
      presentationMeta: (_args, value) => value
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      return executeGenerate(options, args, exec);
    },
    isConcurrencySafe: (): boolean => false
  };
}

export function createListTool(options: ImageToolsOptions): ToolDefinition {
  return {
    name: LIST_IMAGES_TOOL_NAME,
    description: "List durable image handles authorized by the current session with bounded pagination.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of images to return (1-20, default 5)."
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous list_images response."
        },
        origin: {
          type: "string",
          enum: [...IMAGE_ORIGINS],
          description: "Filter by image origin (all, generated, reference, user)."
        }
      },
      additionalProperties: false
    },
    output: {
      schema: listSchema as unknown as Record<string, unknown>,
      render: (_args, value): ContentBlock[] => renderList(value as unknown as ListImagesResult),
      presentationMeta: (_args, value) => value
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      return executeList(options, args, exec);
    },
    isConcurrencySafe: (): boolean => true
  };
}

export async function executeGenerate(
  options: ImageToolsOptions,
  rawArgs: unknown,
  exec: ToolRunContext
): Promise<GenerateImageResult> {
  const settings = options.settings?.() ?? {
    enabled: true,
    model: ANTIGRAVITY_IMAGE_MODEL,
    n: 1
  };
  if (settings.enabled === false) {
    throw new AntigravityImageError("Antigravity Image is disabled by its capability gate", "IMAGE_DISABLED");
  }

  const args = parseGenerateArgs(rawArgs, settings);
  const credential = await requireCredential(options.auth, exec.signal);
  const agent = requireAgent(exec);
  const cwd = workspaceCwd(agent);

  const admission = {
    attachments: options.attachments,
    fs: options.fs
  };

  const references: ImageItemResult[] = [];
  const referenceParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

  for (const [index, reference] of args.references.entries()) {
    const admitted =
      reference.kind === "session" && reference.handle !== undefined
        ? await admitSessionImage(admission, agent, reference.handle, exec.signal)
        : reference.path !== undefined
          ? await admitWorkspaceImage(admission, cwd, reference.path, exec.signal)
          : undefined;
    if (admitted === undefined) {
      throw new AntigravityImageError("Reference image target is missing", "INVALID_ARGS");
    }
    const storedRef = admitted.stored?.ref ?? (await options.attachments.saveImage(admitted.input));
    const storedData = admitted.stored?.data ?? admitted.input.data;

    const item: ImageItemResult = {
      handle: imageHandle(storedRef),
      attachment: storedRef,
      origin: "reference",
      seq: index
    };
    references.push(item);
    referenceParts.push({
      inlineData: {
        mimeType: storedRef.mediaType,
        data: Buffer.from(storedData).toString("base64")
      }
    });
  }

  const transport = options.transport;
  if (transport === undefined) {
    throw new AntigravityImageError("The Antigravity Image transport is unavailable", "IMAGE_FAILED");
  }

  const body = buildImagePayload(args.prompt, args.model, credential, referenceParts);
  const images: ImageItemResult[] = [];
  const warnings: Array<{ index: number; code: string }> = [];
  let firstFailure: AntigravityImageError | undefined;

  for (let index = 0; index < args.n; index += 1) {
    let response: Response;
    try {
      response = await transport.request({
        url: ANTIGRAVITY_IMAGE_ENDPOINT,
        accessToken: credential.accessToken,
        body: JSON.stringify(body),
        signal: exec.signal
      });
    } catch (error) {
      const failure = toImageError(error);
      if (failure.code === "IMAGE_CANCELLED") throw failure;
      firstFailure ??= failure;
      warnings.push({ index, code: imageRequestWarning(failure.code) });
      continue;
    }

    const statusError = privateStatusError(response.status);
    if (statusError !== undefined) {
      await response.body?.cancel().catch(() => {});
      const failure = toImageError(statusError);
      firstFailure ??= failure;
      warnings.push({ index, code: imageRequestWarning(failure.code) });
      continue;
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(
        await readPrivateText(response, {
          signal: exec.signal,
          maxBytes: DEFAULT_PRIVATE_RESPONSE_BYTES
        })
      );
    } catch (error) {
      const failure = toImageError(error);
      if (failure.code === "IMAGE_CANCELLED") throw failure;
      firstFailure ??= failure;
      warnings.push({ index, code: "IMAGE_RESPONSE_INVALID" });
      continue;
    }

    const candidate = collectInlineData(envelope)[0];
    if (candidate === undefined) {
      firstFailure ??= new AntigravityImageError(
        "Antigravity Image returned no admitted inlineData",
        "IMAGE_RESPONSE_EMPTY"
      );
      warnings.push({ index, code: "IMAGE_RESPONSE_EMPTY" });
      continue;
    }

    try {
      const admitted = await admitBase64Image(
        options,
        candidate.data,
        "inline",
        `generated-${String(index + 1)}`,
        exec.signal
      );
      if (
        candidate.mediaType !== undefined &&
        normalizeImageMime(candidate.mediaType) !== admitted.input.mediaType
      ) {
        throw new AntigravityImageError(
          "The declared image MIME did not match the admitted magic bytes",
          "IMAGE_MIME_MISMATCH"
        );
      }
      const attachment = await options.attachments.saveImage(admitted.input);
      images.push({
        handle: imageHandle(attachment),
        attachment,
        origin: "generated",
        seq: index
      });
    } catch (error) {
      if (exec.signal.aborted) {
        throw new AntigravityImageError("Antigravity Image generation was cancelled", "IMAGE_CANCELLED");
      }
      if (error instanceof AntigravityImageError && error.code === "MEDIA_CANCELLED") {
        throw new AntigravityImageError("Antigravity Image generation was cancelled", "IMAGE_CANCELLED");
      }
      const failure =
        error instanceof AntigravityImageError && error.code === "IMAGE_MIME_MISMATCH"
          ? error
          : new AntigravityImageError("The generated image failed media admission", "IMAGE_ADMISSION_FAILED");
      firstFailure ??= failure;
      warnings.push({ index, code: failure.code });
    }
  }

  if (images.length === 0) {
    if (firstFailure !== undefined) throw firstFailure;
    throw new AntigravityImageError("No generated image passed media admission", "IMAGE_RESPONSE_INVALID");
  }

  return {
    operation: references.length === 0 ? "generate" : "edit",
    images,
    references,
    warnings
  };
}

export async function executeList(
  options: ImageToolsOptions,
  rawArgs: unknown,
  exec: ToolRunContext
): Promise<ListImagesResult> {
  const settings = options.settings?.() ?? {
    enabled: true,
    model: ANTIGRAVITY_IMAGE_MODEL,
    n: 1
  };
  if (settings.enabled === false) {
    throw new AntigravityImageError("Antigravity Image is disabled by its capability gate", "IMAGE_DISABLED");
  }

  await requireCredential(options.auth, exec.signal);
  const agent = requireAgent(exec);
  const args = parseListArgs(rawArgs);

  let items: readonly ImageItemResult[] = collectImages(agent);
  if (args.origin !== "all") {
    items = items.filter((item) => item.origin === args.origin);
  }
  if (args.cursor !== undefined) {
    items = afterCursor(items, args.cursor, args.origin);
  }

  const selected = items.slice(0, args.limit);
  const lastItem = selected[selected.length - 1];
  return {
    items: selected,
    ...items.length > selected.length && lastItem !== undefined
      ? { nextCursor: encodeCursor(lastItem, args.origin) }
      : {}
  };
}

export function buildImagePayload(
  prompt: string,
  model: string,
  credential: ImageToolsCredential,
  referenceParts: readonly { inlineData: { mimeType: string; data: string } }[]
): Record<string, unknown> {
  const resolved = resolveModelWithTier(model, { cli_first: false });
  if (resolved.isImageModel !== true) {
    throw new AntigravityImageError("The selected Antigravity model is not an image model", "INVALID_ARGS");
  }

  const project = credential.projectId === "inductive-dreamer-qrkws" || !credential.projectId
    ? undefined
    : credential.projectId;

  return {
    ...project === undefined ? {} : { project },
    model: resolved.actualModel,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, ...referenceParts]
        }
      ],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
    }
  };
}

export function parseGenerateArgs(value: unknown, settings: { model?: string; n?: number }): GenerateImageArgs {
  if (!isRecord(value) || hasExtra(value, ["prompt", "references", "model", "n"])) {
    throw new AntigravityImageError("generate_image expects a closed prompt object", "INVALID_ARGS");
  }
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0 || value.prompt.length > 16384) {
    throw new AntigravityImageError("generate_image expects a non-empty prompt within 16384 chars", "INVALID_ARGS");
  }

  const refs = value.references === undefined ? [] : parseReferences(value.references);
  const model = nonBlank(value.model ?? settings.model ?? ANTIGRAVITY_IMAGE_MODEL);
  const n = integer(value.n ?? settings.n ?? 1, 1, MAX_IMAGES);

  return {
    prompt: value.prompt.trim().slice(0, 16384),
    references: refs,
    model,
    n
  };
}

export function parseListArgs(value: unknown): ListImagesArgs {
  if (!isRecord(value) || hasExtra(value, ["limit", "cursor", "origin"])) {
    throw new AntigravityImageError("list_images expects a closed object", "INVALID_ARGS");
  }

  const limit = value.limit === undefined ? 5 : integer(value.limit, 1, 20);
  const cursor = value.cursor === undefined ? undefined : nonBlank(value.cursor);
  const origin = value.origin === undefined ? "all" : (enumValue(value.origin, IMAGE_ORIGINS) as ImageOrigin);

  return {
    limit,
    ...cursor === undefined ? {} : { cursor },
    origin
  };
}

function parseReferences(value: unknown): readonly ImageReferenceInput[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) {
    throw new AntigravityImageError("references exceed the bounded limit", "INVALID_ARGS");
  }

  return value.map((item) => {
    if (!isRecord(item) || hasExtra(item, ["kind", "handle", "path"]) || typeof item.kind !== "string") {
      throw new AntigravityImageError("reference is invalid", "INVALID_ARGS");
    }
    if (item.kind === "session" && typeof item.handle === "string" && IMAGE_HANDLE_PATTERN.test(item.handle)) {
      return { kind: "session", handle: item.handle };
    }
    if (item.kind === "workspace" && typeof item.path === "string" && item.path.length > 0) {
      return { kind: "workspace", path: item.path };
    }
    throw new AntigravityImageError("reference is invalid", "INVALID_ARGS");
  });
}

export function afterCursor(
  items: readonly ImageItemResult[],
  cursor: string,
  origin: ImageOrigin
): readonly ImageItemResult[] {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AntigravityImageError("The image cursor is invalid", "IMAGE_CURSOR_INVALID");
  }

  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    hasExtra(value, ["id", "seq", "origin"]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    !Number.isSafeInteger(value.seq) ||
    value.origin !== origin
  ) {
    throw new AntigravityImageError("The image cursor is invalid", "IMAGE_CURSOR_INVALID");
  }

  const index = items.findIndex(
    (item) => item.seq === value.seq && String(item.attachment.attachmentId) === value.id
  );
  if (index < 0) {
    throw new AntigravityImageError("The image cursor is stale", "IMAGE_CURSOR_INVALID");
  }

  return items.slice(index + 1);
}

export function encodeCursor(item: ImageItemResult, origin: ImageOrigin): string {
  return Buffer.from(
    JSON.stringify({
      id: String(item.attachment.attachmentId),
      seq: item.seq,
      origin
    })
  ).toString("base64url");
}

export function collectInlineData(
  value: unknown
): Array<{ data: string; mediaType?: string }> {
  const output: Array<{ data: string; mediaType?: string }> = [];
  const visit = (item: unknown, depth = 0) => {
    if (output.length >= MAX_IMAGES || depth > 32) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!isRecord(item)) return;

    const inline = isRecord(item.inlineData)
      ? item.inlineData
      : isRecord(item.inline_data)
        ? item.inline_data
        : undefined;

    if (inline !== undefined && typeof inline.data === "string") {
      const mediaType = typeof inline.mimeType === "string" ? inline.mimeType : typeof inline.mime_type === "string" ? inline.mime_type : undefined;
      output.push({
        data: inline.data,
        ...mediaType === undefined ? {} : { mediaType }
      });
      return;
    }

    for (const child of Object.values(item)) {
      visit(child, depth + 1);
    }
  };

  visit(value);
  return output;
}

function collectImages(agent: Agent): ImageItemResult[] {
  return sessionImageCatalog(agent)
    .map((entry) => ({
      handle: entry.handle,
      attachment: entry.attachment,
      origin: entry.origin,
      seq: entry.sequence
    }))
    .sort(
      (left, right) =>
        right.seq - left.seq ||
        String(right.attachment.attachmentId).localeCompare(String(left.attachment.attachmentId))
    );
}

function renderGenerate(value: GenerateImageResult): ContentBlock[] {
  return [
    {
      type: "text",
      text: `Created ${String(value.images.length)} durable image(s): ${value.images.map((item) => item.handle).join(", ")}.`
    },
    ...value.references.map((item): ContentBlock => ({
      type: "image",
      attachment: item.attachment
    })),
    ...value.images.map((item): ContentBlock => ({
      type: "image",
      attachment: item.attachment
    }))
  ];
}

function renderList(value: ListImagesResult): ContentBlock[] {
  return [
    {
      type: "text",
      text:
        value.items.length === 0
          ? "No authorized session images matched."
          : value.items.map((item) => `${item.handle} (${item.origin})`).join(", ")
    },
    ...value.items.map((item): ContentBlock => ({
      type: "image",
      attachment: item.attachment
    }))
  ];
}

async function requireCredential(
  auth: ImageToolsOptions["auth"],
  signal?: AbortSignal
): Promise<ImageToolsCredential> {
  const credential = await auth.credential(signal);
  if (credential === undefined) {
    throw new AntigravityImageError("Antigravity Image requires a logged-in account", "IMAGE_AUTH_REQUIRED");
  }
  return credential;
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) {
    throw new AntigravityImageError("Antigravity Image requires an active session", "IMAGE_AGENT_REQUIRED");
  }
  return exec.agent;
}

function workspaceCwd(agent: Agent): string {
  const session = (agent as unknown as { session?: { header?: { cwd?: string } } }).session;
  const cwd = session?.header?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new AntigravityImageError("Antigravity Image requires an active workspace", "IMAGE_WORKSPACE_REQUIRED");
  }
  return cwd;
}

function normalizeImageMime(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/webp" ||
    normalized === "image/gif"
    ? normalized
    : undefined;
}

function imageRequestWarning(code: string): string {
  if (code === "IMAGE_AUTH_REQUIRED") return "IMAGE_REQUEST_UNAUTHENTICATED";
  if (code === "IMAGE_RATE_LIMITED") return "IMAGE_REQUEST_RATE_LIMITED";
  if (code === "IMAGE_TIMEOUT") return "IMAGE_REQUEST_TIMEOUT";
  if (code === "IMAGE_PROTOCOL_DRIFT") return "IMAGE_REQUEST_PROTOCOL_DRIFT";
  return "IMAGE_REQUEST_FAILED";
}

const IMAGE_FAILURE_CODES: Record<string, string> = {
  authentication: "IMAGE_AUTH_REQUIRED",
  forbidden: "IMAGE_FORBIDDEN",
  "rate-limited": "IMAGE_RATE_LIMITED",
  cancelled: "IMAGE_CANCELLED",
  timeout: "IMAGE_TIMEOUT",
  "attribution-rejected": "IMAGE_PROTOCOL_DRIFT",
  "protocol-drift": "IMAGE_PROTOCOL_DRIFT",
  "response-limit": "IMAGE_PROTOCOL_DRIFT",
  "request-limit": "IMAGE_PROTOCOL_DRIFT",
  upstream: "IMAGE_FAILED",
  network: "IMAGE_FAILED",
  failed: "IMAGE_FAILED"
};

function toImageError(error: unknown): AntigravityImageError {
  if (error instanceof AntigravityImageError) return error;
  if (error instanceof PrivateTransportError) {
    return new AntigravityImageError(
      "The Antigravity Image request failed safely",
      IMAGE_FAILURE_CODES[classifyPrivateFailure(error)] ?? "IMAGE_FAILED"
    );
  }
  return new AntigravityImageError("The Antigravity Image request failed safely", "IMAGE_FAILED");
}

function hasExtra(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function nonBlank(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new AntigravityImageError("The image option is invalid", "INVALID_ARGS");
  }
  return value.trim();
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AntigravityImageError("The image option is invalid", "INVALID_ARGS");
  }
  return value;
}

function enumValue(value: unknown, values: readonly string[]): string {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new AntigravityImageError("The image option is invalid", "INVALID_ARGS");
  }
  return value;
}
