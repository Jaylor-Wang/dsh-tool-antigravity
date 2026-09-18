import type * as tls from "node:tls";
import type { Buffer } from "node:buffer";

export interface SocketPoolOptions {
  maxIdleSocketsPerOrigin?: number;
  idleTimeoutMs?: number;
  sessionCacheTtlMs?: number;
}

interface IdleSocket {
  socket: tls.TLSSocket;
  origin: string;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

const DEFAULT_MAX_IDLE = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TTL_MS = 300_000;

export class TlsSocketPool {
  private readonly maxIdle: number;
  private readonly idleTimeoutMs: number;
  private readonly sessionTtlMs: number;

  /** Idle sockets keyed by origin. */
  private readonly idleByOrigin = new Map<string, IdleSocket[]>();
  /** Cached TLS session tickets keyed by origin. */
  private readonly sessionTickets = new Map<string, { ticket: Buffer; expiresAt: number }>();

  constructor(options: SocketPoolOptions = {}) {
    this.maxIdle = options.maxIdleSocketsPerOrigin ?? DEFAULT_MAX_IDLE;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sessionTtlMs = options.sessionCacheTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  /** Retrieve a cached TLS session ticket for 1-RTT resumption if still valid. */
  getSessionTicket(origin: string): Buffer | undefined {
    const entry = this.sessionTickets.get(origin);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.sessionTickets.delete(origin);
      return undefined;
    }
    return entry.ticket;
  }

  /** Cache a newly negotiated TLS session ticket. */
  setSessionTicket(origin: string, ticket: Buffer): void {
    this.sessionTickets.set(origin, {
      ticket,
      expiresAt: Date.now() + this.sessionTtlMs
    });
  }

  /** Acquire an idle, alive TLS socket for the target origin, or return undefined. */
  acquire(origin: string): tls.TLSSocket | undefined {
    const list = this.idleByOrigin.get(origin);
    if (!list || list.length === 0) return undefined;

    while (list.length > 0) {
      const entry = list.pop();
      if (!entry) break;
      clearTimeout(entry.timer);
      entry.cleanup();

      const sock = entry.socket;
      if (!sock.destroyed && sock.readable && sock.writable && !sock.pending) {
        return sock;
      }
      sock.destroy();
    }
    return undefined;
  }

  /** Return a healthy socket to the pool for reuse. */
  release(origin: string, socket: tls.TLSSocket): void {
    if (socket.destroyed || !socket.readable || !socket.writable) {
      socket.destroy();
      return;
    }

    let list = this.idleByOrigin.get(origin);
    if (!list) {
      list = [];
      this.idleByOrigin.set(origin, list);
    }

    if (list.length >= this.maxIdle) {
      socket.destroy();
      return;
    }

    // Set up idle listeners: if server closes or errors during idle, drop it.
    const onIdleEvent = () => {
      this.removeIdleSocket(origin, socket);
      socket.destroy();
    };

    const timer = setTimeout(onIdleEvent, this.idleTimeoutMs);
    // Unref timer so it doesn't hold open the Node process
    timer.unref();

    const cleanup = () => {
      socket.removeListener("error", onIdleEvent);
      socket.removeListener("close", onIdleEvent);
      socket.removeListener("end", onIdleEvent);
      socket.removeListener("data", onIdleEvent);
    };

    socket.once("error", onIdleEvent);
    socket.once("close", onIdleEvent);
    socket.once("end", onIdleEvent);
    socket.once("data", onIdleEvent); // Unexpected bytes in idle state -> drop

    list.push({ socket, origin, timer, cleanup });
  }

  /** Remove a specific socket from the idle list without double-destroying. */
  private removeIdleSocket(origin: string, socket: tls.TLSSocket): void {
    const list = this.idleByOrigin.get(origin);
    if (!list) return;
    const index = list.findIndex((entry) => entry.socket === socket);
    if (index !== -1) {
      const [entry] = list.splice(index, 1);
      clearTimeout(entry.timer);
      entry.cleanup();
    }
    if (list.length === 0) {
      this.idleByOrigin.delete(origin);
    }
  }

  /** Close and dispose of all pooled sockets. */
  destroy(): void {
    for (const [_, list] of this.idleByOrigin) {
      for (const entry of list) {
        clearTimeout(entry.timer);
        entry.cleanup();
        entry.socket.destroy();
      }
    }
    this.idleByOrigin.clear();
    this.sessionTickets.clear();
  }
}
