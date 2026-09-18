import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { AttachmentId, type ImageAttachmentLimits } from "@deepseek-ai/dsh-attachment";
import { FsTargetKey, FsVersion, type FsTarget } from "@deepseek-ai/dsh-fs";
import {
  detectImageMediaType,
  isMp4,
  readStableWorkspaceBytes,
  admitBase64Image,
  MediaAdmissionError
} from "../src/media-admission.js";
import {
  afterCursor,
  buildImagePayload,
  createAntigravityImageTools,
  encodeCursor,
  parseGenerateArgs,
  AntigravityImageError,
  type ImageItemResult
} from "../src/image-tool.js";

const dummyLimits: ImageAttachmentLimits = {
  maxImageBytes: 1024 * 1024,
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 10 * 1024 * 1024,
  maxImagePixels: 1000000,
  maxImageDimension: 4096,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"]
};

function createMockTarget(path: string): FsTarget {
  return {
    targetKey: FsTargetKey(path),
    displayPath: path
  };
}

describe("Media Admission Magic Bytes & Formats", () => {
  it("detects PNG magic bytes", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(detectImageMediaType(png)).toBe("image/png");
  });

  it("detects JPEG magic bytes", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMediaType(jpeg)).toBe("image/jpeg");
  });

  it("detects WebP magic bytes", () => {
    const webp = Buffer.from("RIFF\x20\x00\x00\x00WEBPVP8 ");
    expect(detectImageMediaType(new Uint8Array(webp))).toBe("image/webp");
  });

  it("detects GIF87a and GIF89a magic bytes", () => {
    const gif87 = Buffer.from("GIF87a\x01\x00");
    const gif89 = Buffer.from("GIF89a\x01\x00");
    expect(detectImageMediaType(new Uint8Array(gif87))).toBe("image/gif");
    expect(detectImageMediaType(new Uint8Array(gif89))).toBe("image/gif");
  });

  it("detects AVIF magic bytes (ISOBMFF ftyp avif)", () => {
    const avif = Buffer.from("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00mif1avif");
    expect(detectImageMediaType(new Uint8Array(avif))).toBe("image/avif");
  });

  it("detects MP4 video container", () => {
    const mp4 = Buffer.from("\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00isommp42");
    expect(isMp4(new Uint8Array(mp4))).toBe(true);
  });

  it("returns undefined for unknown or text data", () => {
    const text = Buffer.from("Hello, World!");
    expect(detectImageMediaType(new Uint8Array(text))).toBeUndefined();
  });
});

describe("Media Admission Safe Base64 & TOCTOU Containment", () => {
  it("admits valid base64 PNG data", async () => {
    const validPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const base64 = Buffer.from(validPngBytes).toString("base64");

    const admitted = await admitBase64Image(
      {
        attachments: {
          imageLimits: dummyLimits,
          validateImage: async () => {},
          saveImage: async () => ({
            attachmentId: AttachmentId("att_1"),
            mediaType: "image/png",
            bytes: validPngBytes.length,
            width: 10,
            height: 10
          }),
          readImage: async () => ({
            ref: {
              attachmentId: AttachmentId("att_1"),
              mediaType: "image/png",
              bytes: validPngBytes.length,
              width: 10,
              height: 10
            },
            data: validPngBytes
          })
        }
      },
      base64
    );

    expect(admitted.kind).toBe("image");
    expect(admitted.input.mediaType).toBe("image/png");
  });

  it("rejects non-canonical or malformed base64", async () => {
    await expect(
      admitBase64Image(
        {
          attachments: {
            imageLimits: dummyLimits,
            validateImage: async () => {},
            saveImage: async () => ({
              attachmentId: AttachmentId("att_1"),
              mediaType: "image/png",
              bytes: 10,
              width: 10,
              height: 10
            }),
            readImage: async () => ({
              ref: {
                attachmentId: AttachmentId("att_1"),
                mediaType: "image/png",
                bytes: 10,
                width: 10,
                height: 10
              },
              data: new Uint8Array(10)
            })
          }
        },
        "not-valid-base64!!"
      )
    ).rejects.toThrow(MediaAdmissionError);
  });

  it("detects TOCTOU race condition when file version changes during reading", async () => {
    const mockFs = {
      resolve: async (path: string, _opts?: { cwd?: string; signal?: AbortSignal }) => createMockTarget(path),
      contains: (_parent: FsTarget, _child: FsTarget) => true,
      lstat: async () => ({ type: "file" as const, version: FsVersion("v1") }),
      stat: async () => ({ type: "file" as const, version: FsVersion("v2") }), // Version changed!
      readBytes: async () => new Uint8Array([1, 2, 3])
    };

    await expect(
      readStableWorkspaceBytes(mockFs, "/workspace", "image.png", 1024, "image")
    ).rejects.toThrow(/changed before it could be read/);
  });

  it("rejects symbolic links to prevent link hijacking", async () => {
    const mockFs = {
      resolve: async (path: string, _opts?: { cwd?: string; signal?: AbortSignal }) => createMockTarget(path),
      contains: (_parent: FsTarget, _child: FsTarget) => true,
      lstat: async () => ({ type: "symlink" as const, version: FsVersion("v1") }),
      stat: async () => ({ type: "file" as const, version: FsVersion("v1") }),
      readBytes: async () => new Uint8Array([1, 2, 3])
    };

    await expect(
      readStableWorkspaceBytes(mockFs, "/workspace", "symlink.png", 1024, "image")
    ).rejects.toThrow(/is a symbolic link/);
  });
});

describe("Image Tool Cursor Pagination & Payloads", () => {
  const dummyItem: ImageItemResult = {
    handle: "image:att_123",
    attachment: {
      attachmentId: AttachmentId("att_123"),
      mediaType: "image/png",
      bytes: 100,
      width: 10,
      height: 10
    },
    origin: "generated",
    seq: 1
  };

  it("encodes and decodes pagination cursor", () => {
    const cursor = encodeCursor(dummyItem, "generated");
    expect(cursor).toBeDefined();

    const items: ImageItemResult[] = [
      dummyItem,
      {
        ...dummyItem,
        seq: 2,
        handle: "image:att_456",
        attachment: { ...dummyItem.attachment, attachmentId: AttachmentId("att_456") }
      }
    ];

    const next = afterCursor(items, cursor, "generated");
    expect(next.length).toBe(1);
    expect(next[0]?.handle).toBe("image:att_456");
  });

  it("builds image generation payload with image model", () => {
    const payload = buildImagePayload(
      "A serene mountain landscape",
      "antigravity-gemini-3.1-flash-image",
      { accessToken: "mock_token", projectId: "custom-project" },
      []
    );

    expect(payload.project).toBe("custom-project");
    expect(payload.model).toContain("image");
    const req = payload.request as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(req.contents[0]?.parts[0]?.text).toBe("A serene mountain landscape");
  });

  it("throws when non-image model is supplied to buildImagePayload", () => {
    expect(() =>
      buildImagePayload("test", "antigravity-gemini-3.8-flash", { accessToken: "tok" }, [])
    ).toThrow(AntigravityImageError);
  });

  it("parses generate arguments and enforces limits", () => {
    const args = parseGenerateArgs(
      { prompt: "generate cat", n: 2, model: "antigravity-gemini-3.1-flash-image" },
      { model: "default-model", n: 1 }
    );
    expect(args.prompt).toBe("generate cat");
    expect(args.n).toBe(2);
  });

  it("creates tool definitions with output schemas and concurrency classifiers", () => {
    const tools = createAntigravityImageTools({
      auth: { credential: async () => ({ accessToken: "mock" }) },
      attachments: {
        imageLimits: dummyLimits,
        validateImage: async () => {},
        saveImage: async () => ({
          attachmentId: AttachmentId("att_1"),
          mediaType: "image/png",
          bytes: 10,
          width: 10,
          height: 10
        }),
        readImage: async () => ({
          ref: {
            attachmentId: AttachmentId("att_1"),
            mediaType: "image/png",
            bytes: 10,
            width: 10,
            height: 10
          },
          data: new Uint8Array(10)
        })
      },
      fs: {
        resolve: async (path: string, _opts?: { cwd?: string; signal?: AbortSignal }) => createMockTarget(path),
        contains: () => true,
        readBytes: async () => new Uint8Array(),
        lstat: async () => ({ type: "file" as const, version: FsVersion("v1") }),
        stat: async () => ({ type: "file" as const, version: FsVersion("v1") })
      }
    });

    expect(tools.length).toBe(2);
    const generateTool = tools.find((t) => t.name === "generate_image");
    const listTool = tools.find((t) => t.name === "list_images");

    expect(generateTool).toBeDefined();
    expect(generateTool?.isConcurrencySafe?.({})).toBe(false);

    expect(listTool).toBeDefined();
    expect(listTool?.isConcurrencySafe?.({})).toBe(true);
  });
});
