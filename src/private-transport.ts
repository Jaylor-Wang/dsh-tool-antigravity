import * as net from "node:net";
import * as tls from "node:tls";
import { Buffer } from "node:buffer";
import { PassThrough, Transform, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  ANTIGRAVITY_WIRE_ORIGINS,
  ANTIGRAVITY_WIRE_PATHS,
  createWireIdentity,
  type WireIdentity
} from "./wire-identity.js";
import { TlsSocketPool } from "./socket-pool.js";

export const DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS = 180_000;
export const DEFAULT_PRIVATE_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS = 300_000;
export const DEFAULT_PRIVATE_RESPONSE_BYTES = 8_388_608;
export const DEFAULT_PRIVATE_REQUEST_BYTES = 16_777_216;
export const MAX_PRIVATE_REQUEST_BYTES = 67_108_864;
export const DEFAULT_PRIVATE_FRAME_BYTES = 524_288;
const MAX_RESPONSE_HEAD_BYTES = 65_536;
const DEFAULT_HTTPS_PORT = 443;
const DEFAULT_PROXY_PORT = 8080;

export type TransportFailureCode =
  | "offline"
  | "cancelled"
  | "authentication"
  | "forbidden"
  | "rate-limited"
  | "upstream"
  | "protocol-drift"
  | "request-too-large"
  | "response-too-large"
  | "frame-too-large"
  | "invalid-response"
  | "attribution-rejected";

export class PrivateTransportError extends Error {
  readonly code: TransportFailureCode;
  readonly accepted?: boolean;
  readonly status?: number;

  constructor(
    code: TransportFailureCode,
    message: string,
    options: { accepted?: boolean; status?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "PrivateTransportError";
    this.code = code;
    this.accepted = options.accepted;
    this.status = options.status;
  }
}

export interface PrivateTransportOptions {
  responseHeaderTimeoutMs?: number;
  maxRequestBytes?: number;
  pool?: TlsSocketPool;
}

export interface PrivateRequestInput {
  url: string;
  accessToken: string;
  body: string | Uint8Array;
  signal?: AbortSignal;
  responseHeaderTimeoutMs?: number;
}

export interface PrivateSseEvent {
  event?: string;
  data: string;
}

export interface PrivateStreamOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  maxFrameBytes?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}
export interface PrivateTransport {
  request: (input: PrivateRequestInput) => Promise<Response>;
}


// Shared singleton pool across default transports
const globalSocketPool = new TlsSocketPool();

export function createPrivateTransport(options: PrivateTransportOptions = {}): PrivateTransport {
  const wire = createWireIdentity();
  const pool = options.pool ?? globalSocketPool;
  const defaultHeaderTimeoutMs = boundedTimeout(
    options.responseHeaderTimeoutMs,
    DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS
  );
  const maxRequestBytes = Math.min(
    Math.max(1, options.maxRequestBytes ?? DEFAULT_PRIVATE_REQUEST_BYTES),
    MAX_PRIVATE_REQUEST_BYTES
  );

  return {
    request: async (input: PrivateRequestInput): Promise<Response> => {
      if (input.signal?.aborted) throw new PrivateTransportError("cancelled", "The private request was cancelled", { accepted: false });

      const bodyBytes = typeof input.body === "string" ? Buffer.byteLength(input.body) : input.body.byteLength;
      if (bodyBytes > maxRequestBytes) {
        throw new PrivateTransportError("request-too-large", "The private request exceeded the byte limit", { accepted: false });
      }

      const headerTimeoutMs = boundedTimeout(input.responseHeaderTimeoutMs, defaultHeaderTimeoutMs);

      // Attempt dispatch with 1 retry on pre-flight socket failure (e.g. stale keep-alive connection)
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          return await dispatchRawRequest(input, wire, pool, headerTimeoutMs);
        } catch (error) {
          if (
            attempt === 1 &&
            error instanceof PrivateTransportError &&
            error.accepted === false &&
            !input.signal?.aborted
          ) {
            // Pre-flight failure: socket was closed before request was processed by upstream, retry once
            continue;
          }
          throw error;
        }
      }
    }
  };
}

async function dispatchRawRequest(
  input: PrivateRequestInput,
  wire: WireIdentity,
  pool: TlsSocketPool,
  timeoutMs: number
): Promise<Response> {
  const targetUrl = new URL(input.url);
  const origin = targetUrl.origin;
  const serialized = wire.serialize(input.url, {
    authorization: `Bearer ${input.accessToken}`,
    body: input.body
  });

  let socket = pool.acquire(origin);
  let isReusedSocket = false;

  if (socket) {
    isReusedSocket = true;
  } else {
    socket = await connectTls(targetUrl, timeoutMs, pool, input.signal);
  }

  let dispatched = false;
  const abort = () => {
    socket?.destroy(new PrivateTransportError("cancelled", "The private request was cancelled", { accepted: dispatched }));
  };

  try {
    if (input.signal?.aborted) throw new PrivateTransportError("cancelled", "The private request was cancelled", { accepted: false });
    input.signal?.addEventListener("abort", abort, { once: true });

    socket.write(serialized);
    dispatched = true;

    const { head, leftover } = await waitForHead(socket, timeoutMs, dispatched, input.signal);
    const parsed = parseResponseHead(head);

    const bodyStream = buildResponseBody(socket, leftover, parsed, origin, pool, input.signal);
    return new Response(bodyStream, {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers
    });
  } catch (error) {
    socket.destroy();
    if (error instanceof PrivateTransportError) throw error;
    // If we reused a socket from pool and failed before receiving head, mark accepted as false so retry can trigger
    throw new PrivateTransportError("offline", "The private endpoint could not be reached", {
      accepted: isReusedSocket ? false : dispatched,
      cause: error
    });
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

async function connectTls(
  url: URL,
  timeoutMs: number,
  pool: TlsSocketPool,
  signal?: AbortSignal
): Promise<tls.TLSSocket> {
  const proxy = resolveHttpsProxy(url);
  const origin = url.origin;
  const sessionTicket = pool.getSessionTicket(origin);

  let socket: tls.TLSSocket;
  if (proxy === undefined) {
    socket = tls.connect({
      host: url.hostname,
      port: Number(url.port || DEFAULT_HTTPS_PORT),
      servername: url.hostname,
      session: sessionTicket
    });
    await waitForConnect(socket, "secureConnect", timeoutMs, signal);
  } else {
    socket = await connectThroughProxy(proxy, url, timeoutMs, sessionTicket, signal);
  }

  // Cache TLS session ticket for future 1-RTT resumption
  socket.on("session", (ticket) => {
    pool.setSessionTicket(origin, ticket);
  });

  return socket;
}

async function connectThroughProxy(
  proxy: URL,
  target: URL,
  timeoutMs: number,
  sessionTicket: Buffer | undefined,
  signal?: AbortSignal
): Promise<tls.TLSSocket> {
  const proxySocket = net.connect({
    host: proxy.hostname,
    port: Number(proxy.port || DEFAULT_PROXY_PORT)
  });
  await waitForConnect(proxySocket, "connect", timeoutMs, signal);

  const targetPort = Number(target.port || DEFAULT_HTTPS_PORT);
  const authHeader = proxyAuthorizationHeader(proxy);
  proxySocket.write(`CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n${authHeader}\r\n`);

  const { head, leftover } = await waitForHead(proxySocket, timeoutMs, false, signal);
  if (!/^HTTP\/1\.[01]\s+2\d\d(?:\s|$)/u.test(head.split("\r\n", 1)[0] ?? "")) {
    proxySocket.destroy();
    throw new PrivateTransportError("offline", "The HTTPS proxy rejected the private connection", { accepted: false });
  }

  if (leftover.byteLength > 0) proxySocket.unshift(leftover);
  proxySocket.resume();

  const socket = tls.connect({
    socket: proxySocket,
    servername: target.hostname,
    session: sessionTicket
  });
  await waitForConnect(socket, "secureConnect", timeoutMs, signal);
  return socket;
}

function buildResponseBody(
  socket: tls.TLSSocket,
  leftover: Buffer,
  head: ParsedHead,
  origin: string,
  pool: TlsSocketPool,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const source = new PassThrough();
  let current: NodeJS.ReadableStream = source;

  if (head.chunked) {
    current = pipeStage(current, new ChunkedDecoder());
  } else if (head.contentLength !== undefined) {
    current = pipeStage(current, new ContentLengthDecoder(head.contentLength));
  }

  if (head.gzip) {
    const gunzip = createGunzip();
    current = pipeStage(current, gunzip);
    current = pipeStage(current, new PassThrough(), () => new PrivateTransportError("protocol-drift", "The private gzip response was malformed"));
  }

  const abort = () => {
    socket.destroy(new PrivateTransportError("cancelled", "The private request was cancelled", { accepted: true }));
  };

  let recycled = false;
  const onStreamComplete = () => {
    signal?.removeEventListener("abort", abort);
    if (recycled) return;
    recycled = true;

    // Check if server requested connection close
    const conn = head.headers.get("connection")?.toLowerCase();
    if (conn === "close" || head.status >= 500) {
      socket.destroy();
    } else {
      pool.release(origin, socket);
    }
  };

  const onStreamError = (error?: unknown) => {
    signal?.removeEventListener("abort", abort);
    if (recycled) return;
    recycled = true;
    socket.destroy(error instanceof Error ? error : undefined);
  };

  socket.once("error", (error) => {
    source.destroy(error instanceof PrivateTransportError ? error : new PrivateTransportError("offline", "The private response stream failed"));
  });

  if (leftover.byteLength > 0) source.write(leftover);
  socket.pipe(source);
  socket.resume();

  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  current.once("end", onStreamComplete);
  current.once("error", onStreamError);
  current.once("close", () => {
    if (!recycled) onStreamError();
  });

  return toWebBody(current);
}

function toWebBody(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
}

function pipeStage(source: NodeJS.ReadableStream, target: NodeJS.ReadWriteStream, mapError = (err: unknown) => err): NodeJS.ReadableStream {
  source.once("error", (error) => (target as Transform).destroy(mapError(error) as Error));
  return source.pipe(target);
}

class ContentLengthDecoder extends Transform {
  private remaining: number;
  constructor(contentLength: number) {
    super();
    this.remaining = contentLength;
    if (contentLength === 0) this.push(null);
  }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.remaining <= 0 || chunk.byteLength > this.remaining) {
      callback(new PrivateTransportError("protocol-drift", "The private response exceeded its declared length"));
      return;
    }
    this.remaining -= chunk.byteLength;
    this.push(chunk);
    if (this.remaining === 0) this.push(null);
    callback();
  }
  _flush(callback: (error?: Error | null) => void) {
    callback(this.remaining === 0 ? undefined : new PrivateTransportError("protocol-drift", "The private response ended before its declared length"));
  }
}

class ChunkedDecoder extends Transform {
  private buffer = Buffer.alloc(0);
  private finished = false;

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.finished && chunk.byteLength > 0) {
      callback(new PrivateTransportError("protocol-drift", "The private chunked response contained trailing bytes"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.flushChunks();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new PrivateTransportError("protocol-drift", "The private chunked response was malformed"));
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.flushChunks();
      callback(this.finished ? undefined : new PrivateTransportError("protocol-drift", "The private chunked response ended early"));
    } catch (error) {
      callback(error instanceof Error ? error : new PrivateTransportError("protocol-drift", "The private chunked response was malformed"));
    }
  }

  private flushChunks() {
    while (!this.finished) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const sizeText = this.buffer.subarray(0, lineEnd).toString("latin1").split(";", 1)[0]?.trim() ?? "";
      if (!/^[0-9A-Fa-f]+$/u.test(sizeText)) throw new PrivateTransportError("protocol-drift", "The private chunk size was malformed");
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size) || size < 0) throw new PrivateTransportError("protocol-drift", "The private chunk size was malformed");
      const chunkStart = lineEnd + 2;
      const chunkEnd = chunkStart + size;
      const end = chunkEnd + 2;
      if (!Number.isSafeInteger(end) || this.buffer.byteLength < end) return;
      if (this.buffer[chunkEnd] !== 13 || this.buffer[chunkEnd + 1] !== 10) {
        throw new PrivateTransportError("protocol-drift", "The private chunk terminator was malformed");
      }
      const payload = this.buffer.subarray(chunkStart, chunkEnd);
      this.buffer = this.buffer.subarray(end);
      if (size === 0) {
        if (this.buffer.byteLength > 0) throw new PrivateTransportError("protocol-drift", "The private chunked response contained trailing bytes");
        this.finished = true;
        this.push(null);
        return;
      }
      this.push(payload);
    }
  }
}

interface ParsedHead {
  status: number;
  statusText: string;
  headers: Headers;
  chunked: boolean;
  contentLength?: number;
  gzip: boolean;
}

function parseResponseHead(head: string): ParsedHead {
  const lines = head.split("\r\n");
  const statusLine = lines[0] ?? "";
  const match = /^HTTP\/1\.[01]\s+(\d\d\d)\s*(.*)$/u.exec(statusLine);
  if (!match?.[1]) throw new PrivateTransportError("protocol-drift", "The private response status line was malformed");

  const status = Number.parseInt(match[1], 10);
  const statusText = match[2] ?? "";
  const headers = new Headers();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    headers.append(name, value);
  }

  const te = headers.get("transfer-encoding")?.toLowerCase();
  const chunked = te?.includes("chunked") ?? false;
  const ce = headers.get("content-encoding")?.toLowerCase();
  const gzip = ce?.includes("gzip") ?? false;

  let contentLength: number | undefined;
  const rawCl = headers.get("content-length");
  if (rawCl) {
    const parsedCl = Number.parseInt(rawCl.trim(), 10);
    if (Number.isSafeInteger(parsedCl) && parsedCl >= 0) contentLength = parsedCl;
  }

  return { status, statusText, headers, chunked, contentLength, gzip };
}

async function waitForHead(
  socket: net.Socket,
  timeoutMs: number,
  dispatched: boolean,
  signal?: AbortSignal
): Promise<{ head: string; leftover: Buffer }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ head: string; leftover: Buffer }>();
  let settled = false;
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  const cleanup = () => {
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("error", onError);
    socket.removeListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  };

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    fn();
  };

  const timer = setTimeout(() => {
    finish(() => reject(new PrivateTransportError("offline", "The private endpoint timed out waiting for response headers", { accepted: dispatched })));
  }, timeoutMs);
  timer.unref();

  const onAbort = () => {
    finish(() => reject(new PrivateTransportError("cancelled", "The private request was cancelled", { accepted: dispatched })));
  };

  const onError = (error: Error) => {
    finish(() => reject(new PrivateTransportError("offline", "The private connection failed", { accepted: dispatched, cause: error })));
  };

  const onClose = () => {
    finish(() => reject(new PrivateTransportError("offline", "The private connection closed prematurely", { accepted: dispatched })));
  };

  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
    const combined = chunks.length === 1 && chunks[0] ? chunks[0] : Buffer.concat(chunks);
    const headEnd = combined.indexOf("\r\n\r\n");

    if (headEnd >= 0) {
      const head = combined.subarray(0, headEnd).toString("latin1");
      const leftover = combined.subarray(headEnd + 4);
      finish(() => resolve({ head, leftover }));
      return;
    }

    if (totalBytes > MAX_RESPONSE_HEAD_BYTES) {
      finish(() => reject(new PrivateTransportError("protocol-drift", "The response head exceeded the maximum allowed size", { accepted: dispatched })));
    }
  };

  socket.on("data", onData);
  socket.once("error", onError);
  socket.once("close", onClose);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return promise;
}

async function waitForConnect(
  socket: net.Socket,
  event: "connect" | "secureConnect",
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  const cleanup = () => {
    clearTimeout(timer);
    socket.removeListener(event, onConnect);
    socket.removeListener("error", onError);
    signal?.removeEventListener("abort", onAbort);
  };

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    fn();
  };

  const timer = setTimeout(() => {
    socket.destroy();
    finish(() => reject(new PrivateTransportError("offline", "Connection timed out", { accepted: false })));
  }, timeoutMs);
  timer.unref();

  const onConnect = () => finish(resolve);
  const onError = (error: Error) => {
    socket.destroy();
    finish(() => reject(new PrivateTransportError("offline", "Connection failed", { accepted: false, cause: error })));
  };
  const onAbort = () => {
    socket.destroy();
    finish(() => reject(new PrivateTransportError("cancelled", "Connection cancelled", { accepted: false })));
  };

  socket.once(event, onConnect);
  socket.once("error", onError);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return promise;
}

function resolveHttpsProxy(url: URL): URL | undefined {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (matchesNoProxy(url.hostname, noProxy)) return undefined;

  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function matchesNoProxy(hostname: string, value: string): boolean {
  if (!value) return false;
  const host = hostname.toLowerCase();
  for (const item of value.split(",")) {
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed === "*" || (trimmed.startsWith(".") ? host.endsWith(trimmed) : host === trimmed || host.endsWith(`.${trimmed}`))) {
      return true;
    }
  }
  return false;
}

function proxyAuthorizationHeader(proxy: URL): string {
  if (!proxy.username) return "";
  try {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    return `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}\r\n`;
  } catch {
    return "";
  }
}

export function privateStatusError(status: number): PrivateTransportError | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401) return new PrivateTransportError("authentication", "The private endpoint requires authentication", { status });
  if (status === 403) return new PrivateTransportError("forbidden", "The private endpoint forbade this account", { status });
  if (status === 429) return new PrivateTransportError("rate-limited", "The private endpoint is rate-limited", { status });
  if (status >= 500) return new PrivateTransportError("upstream", "The private endpoint is unavailable", { status });
  return new PrivateTransportError("protocol-drift", "The private endpoint returned an unexpected status", { status });
}

export async function readPrivateBytes(response: Response, options: PrivateStreamOptions = {}): Promise<Uint8Array> {
  const maxBytes = Math.min(Math.max(1, options.maxBytes ?? DEFAULT_PRIVATE_RESPONSE_BYTES), MAX_PRIVATE_REQUEST_BYTES);
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new PrivateTransportError("response-too-large", "The private response exceeded the byte limit");
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new PrivateTransportError("response-too-large", "The private response exceeded the byte limit");
        chunks.push(value);
      }
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

export async function readPrivateText(response: Response, options: PrivateStreamOptions = {}): Promise<string> {
  const bytes = await readPrivateBytes(response, options);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Optimized zero-copy sliding buffer SSE parser. */
export async function* iteratePrivateSse(
  response: Response,
  options: PrivateStreamOptions = {}
): AsyncGenerator<PrivateSseEvent, void, undefined> {
  if (!response.body) return;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_PRIVATE_FRAME_BYTES;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  let buffer = "";
  let eventName: string | undefined;
  const dataLines: string[] = [];

  const flush = (): PrivateSseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const ev: PrivateSseEvent = {
      ...(eventName ? { event: eventName } : {}),
      data: dataLines.join("\n")
    };
    eventName = undefined;
    dataLines.length = 0;
    return ev;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line.length === 0) {
          const ev = flush();
          if (ev) yield ev;
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith(":")) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim() || undefined;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /u, ""));
        }

        if (buffer.length > maxFrameBytes) {
          throw new PrivateTransportError("frame-too-large", "The private response frame exceeded the byte limit");
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    // Flush any remaining line
    buffer += decoder.decode();
    if (buffer.length > 0 && buffer.startsWith("data:")) {
      dataLines.push(buffer.slice(5).replace(/^ /u, ""));
    }
    const finalEv = flush();
    if (finalEv) yield finalEv;
  } finally {
    reader.releaseLock();
  }
}

export function assertPrivateEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PrivateTransportError("offline", "The private endpoint URL is malformed", { accepted: false });
  }
  if (
    parsed.protocol !== "https:" ||
    !ANTIGRAVITY_WIRE_ORIGINS.includes(parsed.origin) ||
    !ANTIGRAVITY_WIRE_PATHS.includes(parsed.pathname)
  ) {
    throw new PrivateTransportError("forbidden", "The private endpoint URL is not allowlisted", { accepted: false });
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(Math.max(1000, value), 600_000);
}
