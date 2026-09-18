import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isBoundedSafeText } from "./safe-text.js";

export const AUTH_STORE_LOCK_NAME = ".auth.lock";
export const AUTH_STORE_LOCK_TIMEOUT_MS = 10_000;
export const AUTH_STORE_LOCK_STALE_MS = 30_000;
export const AUTH_STORE_LOCK_RETRY_MS = 10;

export class AuthStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthStoreError";
    this.code = code;
  }
}

export interface AuthStoreRecord {
  version: 1;
  refreshToken: string;
  projectId: string;
  revision: number;
  updatedAt: string;
  email?: string;
  lineage?: string;
}

export interface AuthStoreDraft {
  refreshToken: string;
  projectId: string;
  email?: string;
  lineage?: string;
}

export interface AuthStoreOptions {
  now?: () => number;
  platform?: NodeJS.Platform;
}

export interface AuthStore {
  read: () => Promise<AuthStoreRecord | undefined>;
  commit: (draft: AuthStoreDraft) => Promise<AuthStoreRecord>;
  compareAndCommit: (
    expectedRevision: number,
    draft: AuthStoreDraft,
    expectedLineage?: string
  ) => Promise<AuthStoreRecord | undefined>;
  clearIfCurrent: (expectedRevision: number, expectedLineage?: string) => Promise<boolean>;
  clear: () => Promise<void>;
}

/** Resolve the default auth storage path with fallback to existing dsh-antigravity-auth store. */
export function defaultAuthStorePath(
  env = process.env,
  home = env.HOME,
  platform = process.platform
): string {
  if (platform === "win32") {
    const windowsDataHome = env.LOCALAPPDATA ?? env.APPDATA;
    const base = typeof windowsDataHome === "string" && windowsDataHome.length > 0
      ? windowsDataHome
      : env.USERPROFILE ?? home ?? "";
    return join(base, "dsh-tool-antigravity", "auth.json");
  }
  const dataHome = env.XDG_DATA_HOME;
  const base = typeof dataHome === "string" && dataHome.length > 0
    ? dataHome
    : join(home ?? "", ".local", "share");
  return join(base, "dsh-tool-antigravity", "auth.json");
}

/** Fallback path pointing to legacy dsh-antigravity-auth directory for seamless credentials migration. */
export function legacyAuthStorePath(
  env = process.env,
  home = env.HOME,
  platform = process.platform
): string {
  if (platform === "win32") {
    const windowsDataHome = env.LOCALAPPDATA ?? env.APPDATA;
    const base = typeof windowsDataHome === "string" && windowsDataHome.length > 0
      ? windowsDataHome
      : env.USERPROFILE ?? home ?? "";
    return join(base, "dsh-antigravity-auth", "auth.json");
  }
  const dataHome = env.XDG_DATA_HOME;
  const base = typeof dataHome === "string" && dataHome.length > 0
    ? dataHome
    : join(home ?? "", ".local", "share");
  return join(base, "dsh-antigravity-auth", "auth.json");
}

export function createAuthStore(storePath: string, options: AuthStoreOptions = {}): AuthStore {
  const now = options.now ?? (() => Date.now());
  const platform = options.platform ?? process.platform;
  const enqueue = createMutationQueue();

  const read = async (): Promise<AuthStoreRecord | undefined> => {
    const primary = await readAuthRecordForPlatform(storePath, platform);
    if (primary !== undefined) return primary;

    // Check legacy store path as fallback only when using the default store path
    const defaultPath = defaultAuthStorePath(process.env, process.env.HOME, platform);
    if (storePath === defaultPath) {
      const legacyPath = legacyAuthStorePath(process.env, process.env.HOME, platform);
      if (legacyPath !== storePath) {
        const legacy = await readAuthRecordForPlatform(legacyPath, platform);
        if (legacy !== undefined) return legacy;
      }
    }
    return undefined;
  };

  return {
    read,
    commit: (draft) =>
      enqueue(() =>
        withStoreLock(storePath, async () => {
          const current = await read();
          const record = makeRecord(draft, (current?.revision ?? 0) + 1, now());
          await writeAuthRecord(storePath, record, platform);
          return record;
        })
      ),
    compareAndCommit: (expectedRevision, draft, expectedLineage) =>
      enqueue(() =>
        withStoreLock(storePath, async () => {
          const current = await read();
          if ((current?.revision ?? 0) !== expectedRevision) return undefined;
          const lineage = expectedLineage ?? draft.lineage;
          if (lineage === undefined ? current?.lineage !== undefined : current?.lineage !== lineage) {
            return undefined;
          }
          const record = makeRecord(draft, expectedRevision + 1, now());
          await writeAuthRecord(storePath, record, platform);
          return record;
        })
      ),
    clearIfCurrent: (expectedRevision, expectedLineage) =>
      enqueue(() =>
        withStoreLock(storePath, async () => {
          const current = await read();
          if ((current?.revision ?? 0) !== expectedRevision) return false;
          if (expectedLineage === undefined ? current?.lineage !== undefined : current?.lineage !== expectedLineage) {
            return false;
          }
          try {
            await unlink(storePath);
          } catch (error) {
            if (!isNotFound(error)) throw storeIoError();
          }
          await syncDirectory(dirname(storePath));
          return true;
        })
      ),
    clear: () =>
      enqueue(() =>
        withStoreLock(storePath, async () => {
          try {
            await unlink(storePath);
          } catch (error) {
            if (!isNotFound(error)) throw storeIoError();
          }
          await syncDirectory(dirname(storePath));
        })
      )
  };
}

function createMutationQueue() {
  let mutation: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutation.then(operation, operation);
    mutation = next.then(() => {}, () => {});
    return next;
  };
}

/** Check whether a process with given PID is alive. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // EPERM means process exists but we lack permission to signal
  }
}

async function withStoreLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const parent = dirname(path);
  await prepareParent(parent);
  const lockPath = join(parent, AUTH_STORE_LOCK_NAME);
  const deadline = Date.now() + AUTH_STORE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.sync();
        return await operation();
      } finally {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (error instanceof AuthStoreError) throw error;
      if (!isAlreadyExists(error)) throw storeIoError();

      // Optimize: active PID detection eliminates 30s lock hangs on crash
      await removeStaleLock(lockPath);

      if (Date.now() >= deadline) throw conflictError();
      await new Promise((resolve) => setTimeout(resolve, AUTH_STORE_LOCK_RETRY_MS));
    }
  }
}

async function prepareParent(parent: string): Promise<void> {
  try {
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw unsafePermissionsError();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await mkdir(parent, {
      recursive: true,
      mode: 0o700
    });
    // Skip POSIX chmod on Windows
    if (process.platform !== "win32") {
      await chmod(parent, 0o700);
    }
  } catch (error) {
    if (error instanceof AuthStoreError) throw error;
    throw storeIoError();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Active PID detection: immediately reclaim stale locks left by terminated processes. */
async function removeStaleLock(path: string): Promise<void> {
  try {
    const text = await readFile(path, "utf8").catch(() => "");
    const pid = Number.parseInt(text.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (!isProcessAlive(pid)) {
        // Holding process is DEAD! Reclaim lock immediately.
        await unlink(path).catch(() => {});
        return;
      }
    }

    // Fallback threshold check
    const info = await lstat(path);
    if (Date.now() - info.mtimeMs > AUTH_STORE_LOCK_STALE_MS) {
      await unlink(path).catch(() => {});
    }
  } catch (error) {
    if (!isNotFound(error)) return;
  }
}

async function readAuthRecordForPlatform(path: string, platform: NodeJS.Platform): Promise<AuthStoreRecord | undefined> {
  let fileInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    fileInfo = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw storeIoError();
  }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw unsafePermissionsError();
  await assertOwnerOnly(path, platform);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw storeIoError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corruptError();
  }
  return parseRecord(parsed);
}

async function writeAuthRecord(path: string, record: AuthStoreRecord, platform: NodeJS.Platform): Promise<void> {
  const validated = parseRecord(record);
  const parent = dirname(path);
  try {
    await prepareParent(parent);
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }

      if (platform !== "win32") {
        await chmod(temporary, 0o600);
      }
      await rename(temporary, path);
      if (platform !== "win32") {
        await chmod(path, 0o600);
      }
      await syncDirectory(parent);
    } catch {
      await unlink(temporary).catch(() => {});
      throw storeIoError();
    }
  } catch (error) {
    if (error instanceof AuthStoreError) throw error;
    throw storeIoError();
  }
}

async function assertOwnerOnly(path: string, platform: NodeJS.Platform): Promise<void> {
  try {
    const file = await lstat(path);
    const parent = await lstat(dirname(path));
    const unsafePosixMode = platform !== "win32" && ((file.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0);
    if (file.isSymbolicLink() || parent.isSymbolicLink() || !parent.isDirectory() || unsafePosixMode) {
      throw unsafePermissionsError();
    }
  } catch (error) {
    if (error instanceof AuthStoreError) throw error;
    throw storeIoError();
  }
}

function makeRecord(draft: AuthStoreDraft, revision: number, now: number): AuthStoreRecord {
  if (
    typeof draft !== "object" ||
    draft === null ||
    !isBoundedSafeText(draft.refreshToken, 4096) ||
    !isBoundedSafeText(draft.projectId, 4096) ||
    (draft.lineage !== undefined && !isBoundedSafeText(draft.lineage, 4096)) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isFinite(now)
  ) {
    throw corruptError();
  }
  return {
    version: 1,
    refreshToken: draft.refreshToken,
    projectId: draft.projectId,
    revision,
    updatedAt: new Date(now).toISOString(),
    lineage: draft.lineage ?? randomUUID(),
    ...(draft.email === undefined ? {} : { email: validateEmail(draft.email) })
  };
}

function parseRecord(value: unknown): AuthStoreRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw corruptError();
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) throw unsupportedVersionError();

  const refreshToken = obj.refreshToken;
  const projectId = obj.projectId;
  const revision = obj.revision;
  const updatedAt = obj.updatedAt;
  const lineage = obj.lineage;

  if (
    !isBoundedSafeText(refreshToken, 4096) ||
    !isBoundedSafeText(projectId, 4096) ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    (lineage !== undefined && !isBoundedSafeText(lineage, 4096))
  ) {
    throw corruptError();
  }

  const email = obj.email;
  if (email !== undefined && !isBoundedSafeText(email, 4096)) throw corruptError();

  return {
    version: 1,
    refreshToken,
    projectId,
    revision,
    updatedAt,
    ...(email === undefined ? {} : { email }),
    ...(lineage === undefined ? {} : { lineage })
  };
}

function validateEmail(value: unknown): string {
  if (!isBoundedSafeText(value, 4096) || !value.includes("@")) throw corruptError();
  return value;
}

export function corruptError(): AuthStoreError {
  return new AuthStoreError("AUTH_STORE_CORRUPT", "The Antigravity auth store is not valid");
}

export function unsupportedVersionError(): AuthStoreError {
  return new AuthStoreError("AUTH_STORE_UNSUPPORTED_VERSION", "The Antigravity auth store version is unsupported");
}

export function unsafePermissionsError(): AuthStoreError {
  return new AuthStoreError("AUTH_STORE_UNSAFE_PERMISSIONS", "The Antigravity auth store permissions are unsafe");
}

export function storeIoError(): AuthStoreError {
  return new AuthStoreError("AUTH_STORE_IO", "The Antigravity auth store could not be accessed");
}

export function conflictError(): AuthStoreError {
  return new AuthStoreError("AUTH_STORE_CONFLICT", "The Antigravity auth store was locked by another process");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isNotFound(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}
