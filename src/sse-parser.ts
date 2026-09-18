import { Buffer } from "node:buffer";
import {
  DEFAULT_PRIVATE_FRAME_BYTES,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  PrivateTransportError
} from "./private-transport.js";

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

const DOUBLE_NEWLINE_LF = Buffer.from("\n\n");
const DOUBLE_NEWLINE_CRLF = Buffer.from("\r\n\r\n");

/**
 * Strips Google's standard XSSI defense prefix `)]}'\n` from payload data.
 */
export function stripXssiPrefix(text: string): string {
  if (text.startsWith(")]}'\n")) {
    return text.slice(5);
  }
  if (text.startsWith(")]}'\r\n")) {
    return text.slice(6);
  }
  if (text.startsWith(")]}'")) {
    return text.slice(4).trimStart();
  }
  return text;
}

/**
 * High-performance Parser for individual SSE frames.
 */
export function parseSseFrame(frame: string): SseEvent | undefined {
  const cleanFrame = stripXssiPrefix(frame);
  const lines = cleanFrame.split(/\r?\n/);
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) {
      // Empty line or SSE comment - skip
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    } else if (line.startsWith("event:")) {
      const value = line.slice(6);
      event = (value.startsWith(" ") ? value.slice(1) : value).trim();
    } else if (line.startsWith("id:")) {
      const value = line.slice(3);
      id = (value.startsWith(" ") ? value.slice(1) : value).trim();
    }
  }

  if (dataLines.length === 0 && event === undefined && id === undefined) {
    return undefined;
  }

  return {
    ...event !== undefined ? { event } : {},
    ...id !== undefined ? { id } : {},
    data: dataLines.join("\n")
  };
}

/**
 * Zero-copy / sliding window buffer decoder for SSE streams.
 */
export class SseStreamParser {
  private buffer: Buffer = Buffer.alloc(0);
  private totalBytes = 0;
  private readonly maxFrameBytes: number;
  private readonly maxBytes: number;

  constructor(options: { maxFrameBytes?: number; maxBytes?: number } = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_PRIVATE_FRAME_BYTES;
    this.maxBytes = options.maxBytes ?? DEFAULT_PRIVATE_RESPONSE_BYTES;
  }

  /**
   * Pushes incoming chunk into sliding buffer and yields complete parsed SSE events.
   */
  public *push(chunk: Uint8Array): Generator<SseEvent> {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.maxBytes) {
      throw new PrivateTransportError(
        "frame-too-large",
        "The private response stream exceeded the byte limit"
      );
    }

    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);

    while (true) {
      const boundary = this.findFrameBoundary();
      if (boundary === undefined) break;

      if (boundary.index > this.maxFrameBytes) {
        throw new PrivateTransportError(
          "frame-too-large",
          "The private response frame exceeded the byte limit"
        );
      }

      const frameSlice = this.buffer.subarray(0, boundary.index);
      const frameText = frameSlice.toString("utf8");
      this.buffer = this.buffer.subarray(boundary.index + boundary.length);

      const parsed = parseSseFrame(frameText);
      if (parsed !== undefined) {
        yield parsed;
      }
    }

    if (this.buffer.length > this.maxFrameBytes) {
      throw new PrivateTransportError(
        "frame-too-large",
        "The private response frame exceeded the byte limit"
      );
    }
  }

  /**
   * Flushes any remaining bytes in the buffer at stream end.
   */
  public *flush(): Generator<SseEvent> {
    if (this.buffer.length > 0) {
      if (this.buffer.length > this.maxFrameBytes) {
        throw new PrivateTransportError(
          "frame-too-large",
          "The private response frame exceeded the byte limit"
        );
      }
      const frameText = this.buffer.toString("utf8");
      this.buffer = Buffer.alloc(0);
      const parsed = parseSseFrame(frameText);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
  }

  private findFrameBoundary(): { index: number; length: number } | undefined {
    const idxLf = this.buffer.indexOf(DOUBLE_NEWLINE_LF);
    const idxCrlf = this.buffer.indexOf(DOUBLE_NEWLINE_CRLF);

    if (idxLf === -1 && idxCrlf === -1) {
      return undefined;
    }
    if (idxLf !== -1 && (idxCrlf === -1 || idxLf < idxCrlf)) {
      return { index: idxLf, length: 2 };
    }
    return { index: idxCrlf, length: 4 };
  }
}
