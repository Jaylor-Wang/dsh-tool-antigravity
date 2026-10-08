/**
 * Multi-account pool store implementing the single-record {@link AntigravityAuthStore}
 * contract.
 *
 * The pool keeps every signed-in Antigravity account in one `accounts.json` file and
 * projects the *active* account onto the existing single-record interface. Callers keep
 * their current semantics: `compareAndCommit` on an unseen lineage appends a new account
 * instead of replacing the previous one, which is what turns one login slot into a pool.
 *
 * Deterministic and test-friendly: the store never reads the process clock or the
 * environment on its own; `now` and platform checks stay injectable exactly like the
 * single-record store this replaces.
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isBoundedSafeText } from './safe-text.ts'
import {
  AUTH_RECORD_VERSION,
  AuthStoreError,
  readAuthRecord,
  type AntigravityAuthRecord,
  type AntigravityAuthStore,
  type AuthRecordDraft,
  type AuthStoreOptions,
} from './auth-store.ts'

export const AUTH_POOL_VERSION = 1 as const

const POOL_LOCK_NAME = '.pool.lock'
const POOL_LOCK_TIMEOUT_MS = 10_000
const POOL_LOCK_STALE_MS = 30_000
const POOL_LOCK_RETRY_MS = 10

/**
 * One pooled account. Mirrors the single-record shape so a migration is lossless, plus
 * the rotation bookkeeping the coordinator needs to skip a cooling account.
 */
export interface PooledAccount {
  readonly refreshToken: string
  readonly projectId: string
  /** Masked form, safe to display. Never the raw address. */
  readonly email?: string
  /**
   * Salted hash of the raw account address. Used only to tell "signing in again" from
   * "signing in as someone else". The raw address is never persisted: the store holds no
   * plaintext identity, matching the single-record store's contract.
   */
  readonly emailTag?: string
  /** Stable per-account fence; also the key used to find an account again. */
  readonly lineage: string
  readonly addedAt: string
  /** Epoch ms before which this account must not be selected again; absent means ready. */
  readonly cooldownUntil?: number
  /**
   * Rotation failures that count as *consecutive*.
   *
   * Only meaningful together with `lastFailureAt`: the pair is read through
   * {@link effectiveFailureCount}, which resets the tally once the last failure is older
   * than the streak window. A raw counter would keep growing across unrelated failures
   * spread over hours, and the backoff ladder it feeds would over-punish a healthy account.
   */
  readonly consecutiveFailures?: number
  /** Epoch ms of the most recent counted failure; anchors the streak window. */
  readonly lastFailureAt?: number
}

/**
 * Derive a stable, non-reversible identity tag for an account address.
 *
 * The salt is fixed rather than per-install: the tag only has to be stable across logins
 * on the same machine, and a random salt would have to be persisted anyway. A SHA-256
 * digest of a normalised address is not reversible by inspection and never appears as
 * plaintext, which is what the store's privacy contract requires.
 */
export function emailTagFor(email: string | undefined): string | undefined {
  if (email === undefined) return undefined
  const normalized = email.trim().toLowerCase()
  // The same shape `maskForStorage` accepts: an address without a local part cannot
  // identify an account, so it must not produce a tag that pretends it does.
  const at = normalized.indexOf('@')
  if (at <= 0 || at === normalized.length - 1) return undefined
  return createHash('sha256').update(`dsh-tool-antigravity/account/${normalized}`).digest('hex')
}

/**
 * Mask an account address for storage. Only the first character of the local part and the
 * domain survive, so the persisted form identifies nothing on its own.
 */
export function maskForStorage(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0 || at === email.length - 1) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.endsWith('***')) return `${local}@${domain}`
  const head = local.slice(0, 1)
  const tail = local.length > 1 ? local.slice(-1) : ''
  return `${head}***${tail}@${domain}`
}

/**
 * How long a failure keeps counting toward the streak.
 *
 * Matches the longest cooldown the ladder can assign (two hours), so a streak only survives
 * as long as the account it describes is still plausibly struggling. A failure older than
 * this is treated as the start of a fresh streak.
 */
export const FAILURE_STREAK_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * The failure count that should actually drive the next backoff.
 *
 * The stored counter is only meaningful next to the time of its last update: an account that
 * failed once three hours ago and once just now has not failed twice in a row, so the older
 * entry must not inflate the ladder.
 */
export function effectiveFailureCount(
  account: Pick<PooledAccount, 'consecutiveFailures' | 'lastFailureAt'>,
  at: number,
): number {
  const count = account.consecutiveFailures
  if (count === undefined || count <= 0) return 0
  const last = account.lastFailureAt
  // A counter with no anchor cannot be aged out, so it is treated as still recent rather
  // than silently discarded; that keeps older pool files behaving as they did.
  if (last === undefined) return count
  return at - last > FAILURE_STREAK_WINDOW_MS ? 0 : count
}

export interface AuthPoolFile {
  readonly version: typeof AUTH_POOL_VERSION
  readonly accounts: readonly PooledAccount[]
  /** Index into `accounts` used when no family-specific cursor applies. */
  readonly activeIndex: number
  /** Per-LLM-family cursors so a Gemini-only exhaustion never rotates Claude. */
  readonly activeIndexByFamily?: Readonly<Record<string, number>>
  /**
   * Optimistic-concurrency ticket, mirroring the single-record store's `revision`.
   * Starts at 0 for an empty pool so the first `compareAndCommit(0, …)` succeeds, which
   * is the exact call shape a fresh login makes.
   */
  readonly revision: number
  readonly updatedAt: string
}

export interface AuthStorePoolOptions extends AuthStoreOptions {
  /**
   * Selects which pooled account `read()` projects. Kept injectable so the credential
   * coordinator can drive family-aware rotation without this module knowing the model
   * families that exist.
   */
  readonly family?: () => string | undefined
  /**
   * Path of a legacy single-record `auth.json` to fall back on while the pool is empty.
   * Adopting it on read keeps an existing install working after the upgrade without
   * rewriting anything until the next real write.
   */
  readonly legacyStorePath?: string
}

export interface AuthStorePool extends AntigravityAuthStore {
  /** Read the whole pool; never exposed through the single-record interface. */
  readPool(): Promise<AuthPoolFile>
  /** Number of accounts currently in cooldown-free rotation. */
  readyCount(): Promise<number>
  /** Mark `lineage` cooling for `durationMs` and advance the cursor. */
  markCooldown(lineage: string, durationMs: number, family?: string): Promise<void>
  /**
   * Point the cursor at `lineage` so the next read resolves to it.
   *
   * Deliberately does not clear a cooldown: selecting an account is a preference, not
   * proof that it can serve a request, so a resting account stays resting until tried.
   */
  setActive(lineage: string): Promise<boolean>
  /** Drop an account entirely (logout of one account, or a revoked grant). */
  removeAccount(lineage: string): Promise<boolean>
  /** Path of the backing `accounts.json`. */
  readonly path: string
}

/** Resolve the pool path next to the legacy single-record store. */
export function defaultAuthPoolPath(authStorePath: string): string {
  return join(dirname(authStorePath), 'accounts.json')
}

/**
 * Create the multi-account pool store. A missing pool file reads as empty, matching
 * the single-record store's absent-file behaviour.
 */
export function createAuthStorePool(path: string, options: AuthStorePoolOptions = {}): AuthStorePool {
  const now = options.now ?? (() => Date.now())
  const platform = options.platform ?? process.platform
  const family = options.family ?? (() => undefined)
  const legacyStorePath = options.legacyStorePath

  /**
   * Read the pool, adopting a legacy single-record file when the pool itself is empty.
   *
   * The adoption is read-only: `auth.json` is never modified or deleted, so an install
   * that upgrades and then disables multi-account still finds its original file intact.
   * The first genuine write persists the adopted account into the pool.
   */
  const loadPool = async (): Promise<AuthPoolFile> => {
    const pool = await readPoolFile(path, platform)
    if (pool.accounts.length > 0 || legacyStorePath === undefined) return pool
    const legacy = await readLegacyRecord(legacyStorePath)
    return legacy === undefined ? pool : migrateLegacyRecord(pool, legacy)
  }

  /**
   * Seed for the first write: adopting a legacy account is the one case where a mutation
   * may start from something other than the durable pool file.
   */
  const seedFromLegacy = async (): Promise<AuthPoolFile> => loadPool()

  const read = async (): Promise<AntigravityAuthRecord | undefined> => {
    const pool = await loadPool()
    const account = selectAccount(pool, family(), now())
    if (account === undefined) return undefined
    return {
      version: AUTH_RECORD_VERSION,
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      ...(account.email === undefined ? {} : { email: account.email }),
      // Expose the pool's own mutation counter as the record revision: callers use it
      // purely as an optimistic-concurrency ticket, and a pool-wide counter is a
      // strictly stronger fence than a per-account one.
      revision: pool.revision,
      updatedAt: pool.updatedAt,
      lineage: account.lineage,
    }
  }

  const store: AuthStorePool = {
    path,
    read,
    readPool: () => loadPool(),

    commit: draft => mutatePool<never>(path, platform, pool => {
      const exists = pool.accounts.some(account => account.lineage === draft.lineage)
      return {
        ...pool,
        accounts: exists
          ? pool.accounts.map(account => account.lineage === draft.lineage ? applyDraft(account, draft) : account)
          : [...pool.accounts, accountFromDraft(draft, now())],
        revision: pool.revision + 1,
        updatedAt: new Date(now()).toISOString(),
      }
    }, seedFromLegacy).then(pool => projectCommitted(pool, draft, now())),

    compareAndCommit: (expectedRevision, draft, expectedLineage) => mutatePool<undefined>(path, platform, pool => {
      if (pool.revision !== expectedRevision) return undefined
      // Intent is carried by which lineage the caller names, keeping the shapes distinct:
      //   expectedLineage = "the account I am holding"  -> update it, and it must still exist
      //   expectedLineage omitted + draft.lineage named -> a different account is signing in,
      //                                                   so append it
      //   neither named                                 -> replace the active account, which
      //                                                   is the single-record semantics
      //                                                   existing callers rely on
      if (expectedLineage !== undefined) {
        if (!pool.accounts.some(account => account.lineage === expectedLineage)) {
          // The observed account vanished. Silently writing to a different one would attach
          // this credential to the wrong identity, so refuse as the single-record store does.
          return undefined
        }
        return {
          ...pool,
          accounts: pool.accounts.map(account => account.lineage === expectedLineage ? applyDraft(account, { ...draft, lineage: expectedLineage }) : account),
          revision: pool.revision + 1,
          updatedAt: new Date(now()).toISOString(),
        }
      }
      if (draft.lineage !== undefined) {
        return {
          ...pool,
          accounts: pool.accounts.some(account => account.lineage === draft.lineage)
            ? pool.accounts.map(account => account.lineage === draft.lineage ? applyDraft(account, draft) : account)
            : [...pool.accounts, accountFromDraft(draft, now())],
          revision: pool.revision + 1,
          updatedAt: new Date(now()).toISOString(),
        }
      }
      const current = selectAccount(pool, family(), now())
      // An empty pool has nothing to replace, so the write creates the first account.
      if (current === undefined) {
        return {
          ...pool,
          accounts: [accountFromDraft(draft, now())],
          revision: pool.revision + 1,
          updatedAt: new Date(now()).toISOString(),
        }
      }
      return {
        ...pool,
        accounts: pool.accounts.map(account => account.lineage === current.lineage ? applyDraft(account, draft) : account),
        revision: pool.revision + 1,
        updatedAt: new Date(now()).toISOString(),
      }
    }, seedFromLegacy).then(pool => pool === undefined ? undefined : projectCommitted(pool, draft, now())),

    clearIfCurrent: (expectedRevision, expectedLineage) => mutatePool<false>(path, platform, pool => {
      const current = selectAccount(pool, family(), now())
      if (pool.revision !== expectedRevision) return false
      if (expectedLineage === undefined ? current?.lineage !== undefined : current?.lineage !== expectedLineage) return false
      // Clearing "the current account" means removing one account from the pool, not
      // deleting the file: the other signed-in accounts must survive a logout.
      const remaining = current === undefined
        ? pool.accounts
        : pool.accounts.filter(account => account.lineage !== current.lineage)
      return {
        ...pool,
        accounts: remaining,
        activeIndex: reindexAfterRemoval(pool.activeIndex, remaining.length),
        revision: pool.revision + 1,
        updatedAt: new Date(now()).toISOString(),
      }
    }, seedFromLegacy).then(result => result !== false),

    // `clear()` is the full logout path: drop the whole pool file, matching the
    // single-record store's "no file means no account" contract.
    clear: () => withPoolLock(path, async () => {
      try {
        await unlink(path)
      } catch (error) {
        if (!isNotFound(error)) throw new AuthStoreError('AUTH_STORE_IO', 'The Antigravity account pool could not be cleared')
      }
    }),

    readyCount: async () => {
      const pool = await loadPool()
      const at = now()
      return pool.accounts.filter(account => !isCooling(account, at)).length
    },

    markCooldown: (lineage, durationMs, targetFamily) => mutatePool(path, platform, pool => {
      const at = now()
      const until = at + Math.max(0, durationMs)
      const accounts = pool.accounts.map(account => {
        if (account.lineage !== lineage) return account
        // Count within the streak window: a failure after a long gap starts a new streak
        // rather than extending an old one, which keeps the backoff ladder proportional to
        // how persistently the account is actually failing.
        const streak = effectiveFailureCount(account, at) + 1
        return {
          ...account,
          cooldownUntil: until,
          consecutiveFailures: streak,
          lastFailureAt: at,
        }
      })
      // Advancing only the targeted family's cursor is what preserves per-family
      // rotation. When no family is named the pool cursor moves, and every family that
      // has already been rotated is left alone: its own cursor still names the account it
      // last chose, and `selectAccount` will scan past the cooling entry on its own.
      return {
        ...pool,
        accounts,
        ...(targetFamily === undefined
          ? { activeIndex: advanceIndex(pool.activeIndex, accounts.length) }
          : {
              activeIndexByFamily: {
                ...(pool.activeIndexByFamily ?? {}),
                [targetFamily]: advanceIndex(pool.activeIndexByFamily?.[targetFamily] ?? pool.activeIndex, accounts.length),
              },
            }),
        revision: pool.revision + 1,
        updatedAt: new Date(now()).toISOString(),
      }
    }, seedFromLegacy).then(() => {}),

    setActive: lineage => mutatePool<false>(path, platform, pool => {
      const index = pool.accounts.findIndex(account => account.lineage === lineage)
      if (index < 0) return false
      return {
        ...pool,
        activeIndex: index,
        // Every family cursor is repointed too, so a family that had already rotated
        // does not keep resolving to the account the user just moved away from.
        activeIndexByFamily: Object.fromEntries(
          Object.keys(pool.activeIndexByFamily ?? {}).map(family => [family, index]),
        ),
        revision: pool.revision + 1,
        updatedAt: new Date(now()).toISOString(),
      }
    }, seedFromLegacy).then(result => result !== false),

    removeAccount: lineage => mutatePool(path, platform, pool => {
      const accounts = pool.accounts.filter(account => account.lineage !== lineage)
      if (accounts.length === pool.accounts.length) return false
      return {
        ...pool,
        accounts,
        activeIndex: reindexAfterRemoval(pool.activeIndex, accounts.length),
        revision: pool.revision + 1,
        updatedAt: new Date(now()).toISOString(),
      }
    }, seedFromLegacy).then(result => result !== false),
  }

  return store
}

/**
 * Pick the account `read()` should project.
 *
 * Selection is cursor-first: the family cursor (falling back to the pool cursor) names
 * the preferred account, and only if that account is cooling do we scan forward. A
 * per-family cursor is what keeps a Gemini-only exhaustion from rotating Claude, so the
 * scan must never leak across families: it starts from this family's own cursor.
 *
 * When every account is cooling the cursor account is still returned, so credential
 * errors surface as provider failures instead of a misleading "not logged in".
 */
function selectAccount(pool: AuthPoolFile, targetFamily: string | undefined, at: number): PooledAccount | undefined {
  if (pool.accounts.length === 0) return undefined
  // A family with its own recorded cursor is fully independent of the pool cursor: this
  // is what stops a Gemini-only exhaustion from rotating Claude. A family that has never
  // been rotated falls back to the pool cursor as its starting point.
  const familyCursor = targetFamily === undefined ? undefined : pool.activeIndexByFamily?.[targetFamily]
  const cursor = familyCursor ?? pool.activeIndex
  const start = Number.isSafeInteger(cursor) ? Math.max(0, cursor) % pool.accounts.length : 0
  for (let step = 0; step < pool.accounts.length; step += 1) {
    const account = pool.accounts[(start + step) % pool.accounts.length]
    if (account !== undefined && !isCooling(account, at)) return account
  }
  return pool.accounts[start]
}

function isCooling(account: PooledAccount, at: number): boolean {
  return account.cooldownUntil !== undefined && account.cooldownUntil > at
}

function advanceIndex(index: number, length: number): number {
  if (length <= 0) return 0
  const base = Number.isSafeInteger(index) ? Math.max(0, index) : 0
  return (base + 1) % length
}

function reindexAfterRemoval(index: number, length: number): number {
  if (length <= 0) return 0
  const base = Number.isSafeInteger(index) ? Math.max(0, index) : 0
  return base >= length ? length - 1 : base
}

/**
 * Project the account a `compareAndCommit` just wrote.
 *
 * The single-record store returns the record it committed, and callers depend on that: the
 * credential coordinator adopts the returned record as the credential it is about to use.
 * Returning whichever account the cursor happens to point at would hand the caller a
 * different account's token, so the write's own lineage is resolved instead.
 */
function projectCommitted(pool: AuthPoolFile, draft: AuthRecordDraft, at: number): AntigravityAuthRecord {
  const account = draft.lineage === undefined
    ? selectAccount(pool, undefined, at)
    : pool.accounts.find(entry => entry.lineage === draft.lineage)
  if (account === undefined) throw new AuthStoreError('AUTH_STORE_CONFLICT', 'The committed Antigravity account is missing from the pool')
  return {
    version: AUTH_RECORD_VERSION,
    refreshToken: account.refreshToken,
    projectId: account.projectId,
    ...(account.email === undefined ? {} : { email: account.email }),
    revision: pool.revision,
    updatedAt: pool.updatedAt,
    lineage: account.lineage,
  }
}

function projectOrThrow(pool: AuthPoolFile, targetFamily: string | undefined, at: number): AntigravityAuthRecord {
  const account = selectAccount(pool, targetFamily, at)
  if (account === undefined) throw new AuthStoreError('AUTH_STORE_CONFLICT', 'The Antigravity account pool is empty')
  return {
    version: AUTH_RECORD_VERSION,
    refreshToken: account.refreshToken,
    projectId: account.projectId,
    ...(account.email === undefined ? {} : { email: account.email }),
    revision: pool.revision,
    updatedAt: pool.updatedAt,
    lineage: account.lineage,
  }
}

function applyDraft(account: PooledAccount, draft: AuthRecordDraft): PooledAccount {
  // A successful write clears any cooldown and ends the failure streak: the account just
  // proved it works. The `exactOptionalPropertyTypes` setting forbids writing `undefined`
  // over an optional field, so the keys are omitted instead.
  const { cooldownUntil: _cooldown, consecutiveFailures: _failures, lastFailureAt: _lastFailure, ...rest } = account
  void _cooldown
  void _failures
  void _lastFailure
  const tag = emailTagFor(draft.email)
  return {
    ...rest,
    refreshToken: draft.refreshToken,
    projectId: draft.projectId,
    // The masked form is display-only; identity lives in `emailTag`, so the raw address
    // never reaches the file.
    ...(draft.email === undefined ? {} : { email: maskForStorage(draft.email) }),
    ...(tag === undefined ? {} : { emailTag: tag }),
  }
}

function accountFromDraft(draft: AuthRecordDraft, at: number): PooledAccount {
  const tag = emailTagFor(draft.email)
  return {
    refreshToken: draft.refreshToken,
    projectId: draft.projectId,
    ...(draft.email === undefined ? {} : { email: maskForStorage(draft.email) }),
    ...(tag === undefined ? {} : { emailTag: tag }),
    lineage: draft.lineage ?? randomUUID(),
    addedAt: new Date(at).toISOString(),
  }
}

/**
 * Apply one atomic pool mutation. The callback returns either a replacement pool (which
 * is persisted) or one of the sentinel values `false`/`undefined` (which abort the write
 * and are returned verbatim so predicates such as `clearIfCurrent` can report "no-op").
 */
/**
 * Read a legacy single-record `auth.json` without creating, migrating, or modifying it.
 *
 * A missing file and an unreadable one are both "no legacy account": a corrupted legacy
 * file must not stop the pool from working, because the pool is what the user is moving
 * to and the legacy file is only a convenience.
 */
async function readLegacyRecord(path: string): Promise<AntigravityAuthRecord | undefined> {
  try {
    return await readAuthRecord(path)
  } catch {
    return undefined
  }
}

async function mutatePool<T>(
  path: string,
  platform: NodeJS.Platform,
  mutate: (pool: AuthPoolFile) => AuthPoolFile | T,
  seed?: () => Promise<AuthPoolFile>,
): Promise<AuthPoolFile | T> {
  return withPoolLock(path, async () => {
    // Writes start from the durable pool, never from a read-only legacy fallback, so a
    // mutation can never persist state the user never had. `seed` supplies the one
    // legitimate exception: adopting a legacy account into the pool on first write.
    const durable = await readPoolFile(path, platform)
    const current = durable.accounts.length === 0 && seed !== undefined ? await seed() : durable
    const next = mutate(current)
    if (isPoolFile(next)) await writePoolFile(path, next)
    return next
  })
}

function isPoolFile(value: unknown): value is AuthPoolFile {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'accounts' in value && 'version' in value
}

export async function readPoolFile(path: string, platform: NodeJS.Platform = process.platform): Promise<AuthPoolFile> {
  let fileInfo
  try {
    fileInfo = await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return emptyPool()
    throw new AuthStoreError('AUTH_STORE_IO', 'The Antigravity account pool could not be accessed')
  }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new AuthStoreError('AUTH_STORE_UNSAFE_PERMISSIONS', 'The Antigravity account pool permissions are unsafe')
  }
  try {
    await assertOwnerOnly(path, platform)
  } catch {
    throw new AuthStoreError('AUTH_STORE_UNSAFE_PERMISSIONS', 'The Antigravity account pool permissions are unsafe')
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new AuthStoreError('AUTH_STORE_IO', 'The Antigravity account pool could not be accessed')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new AuthStoreError('AUTH_STORE_CORRUPT', 'The Antigravity account pool is not valid')
  }
  return parsePool(parsed)
}

export async function writePoolFile(path: string, pool: AuthPoolFile): Promise<void> {
  const validated = parsePool(pool)
  const parent = dirname(path)
  try {
    await prepareParent(parent)
    const temporary = join(parent, `.${randomUUID()}.pool.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close().catch(() => {})
      }
      await chmod(temporary, 0o600)
      await rename(temporary, path)
      await chmod(path, 0o600)
    } catch {
      await unlink(temporary).catch(() => {})
      throw new AuthStoreError('AUTH_STORE_IO', 'The Antigravity account pool could not be written')
    }
  } catch (error) {
    if (error instanceof AuthStoreError) throw error
    throw new AuthStoreError('AUTH_STORE_IO', 'The Antigravity account pool could not be written')
  }
}

function emptyPool(): AuthPoolFile {
  return { version: AUTH_POOL_VERSION, accounts: [], activeIndex: 0, revision: 0, updatedAt: new Date(0).toISOString() }
}

function parsePool(value: unknown): AuthPoolFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw poolCorrupt()
  const record = value as Record<string, unknown>
  if (record.version !== AUTH_POOL_VERSION) {
    throw new AuthStoreError('AUTH_STORE_UNSUPPORTED_VERSION', 'The Antigravity account pool version is unsupported')
  }
  if (!Array.isArray(record.accounts)) throw poolCorrupt()
  const accounts: PooledAccount[] = []
  for (const entry of record.accounts) accounts.push(parseAccount(entry))
  const activeIndex = Number.isSafeInteger(record.activeIndex) && (record.activeIndex as number) >= 0
    ? Math.min(record.activeIndex as number, Math.max(0, accounts.length - 1))
    : 0
  const byFamily = record.activeIndexByFamily
  const activeIndexByFamily = typeof byFamily === 'object' && byFamily !== null && !Array.isArray(byFamily)
    ? Object.fromEntries(
        Object.entries(byFamily as Record<string, unknown>)
          .filter(([, index]) => Number.isSafeInteger(index) && (index as number) >= 0)
          .map(([key, index]) => [key, index as number]),
      )
    : undefined
  const updatedAt = typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
    ? record.updatedAt
    : new Date(0).toISOString()
  const revision = Number.isSafeInteger(record.revision) && (record.revision as number) >= 0
    ? record.revision as number
    : 0
  return {
    version: AUTH_POOL_VERSION,
    accounts: dedupeByLineage(accounts),
    activeIndex,
    revision,
    ...(activeIndexByFamily === undefined ? {} : { activeIndexByFamily }),
    updatedAt,
  }
}

function parseAccount(value: unknown): PooledAccount {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw poolCorrupt()
  const record = value as Record<string, unknown>
  const refreshToken = record.refreshToken
  const projectId = record.projectId
  const lineage = record.lineage
  if (!isBoundedSafeText(refreshToken, 4096) || !isBoundedSafeText(projectId, 4096) || !isBoundedSafeText(lineage, 4096)) {
    throw poolCorrupt()
  }
  const email = record.email
  if (email !== undefined && !isBoundedSafeText(email, 4096)) throw poolCorrupt()
  const emailTag = record.emailTag
  // A tag is a hex digest; anything else is a malformed file rather than a legacy one.
  if (emailTag !== undefined && (typeof emailTag !== 'string' || !/^[0-9a-f]{64}$/u.test(emailTag))) throw poolCorrupt()
  const addedAt = typeof record.addedAt === 'string' && Number.isFinite(Date.parse(record.addedAt))
    ? record.addedAt
    : new Date(0).toISOString()
  const cooldownUntil = typeof record.cooldownUntil === 'number' && Number.isFinite(record.cooldownUntil)
    ? record.cooldownUntil
    : undefined
  const consecutiveFailures = Number.isSafeInteger(record.consecutiveFailures) && (record.consecutiveFailures as number) >= 0
    ? record.consecutiveFailures as number
    : undefined
  const lastFailureAt = typeof record.lastFailureAt === 'number' && Number.isFinite(record.lastFailureAt)
    ? record.lastFailureAt
    : undefined
  return {
    refreshToken,
    projectId,
    ...(email === undefined ? {} : { email: email as string }),
    ...(emailTag === undefined ? {} : { emailTag }),
    lineage,
    addedAt,
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(consecutiveFailures === undefined ? {} : { consecutiveFailures }),
    ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
  }
}

/** Keep the first entry per lineage: a duplicate lineage would break cursor indexing. */
function dedupeByLineage(accounts: readonly PooledAccount[]): PooledAccount[] {
  const seen = new Set<string>()
  const output: PooledAccount[] = []
  for (const account of accounts) {
    if (seen.has(account.lineage)) continue
    seen.add(account.lineage)
    output.push(account)
  }
  return output
}

/**
 * Adopt a legacy single-record `auth.json` into an empty pool. Existing users keep
 * their session: the same refresh token, project, email and lineage carry over.
 */
export function migrateLegacyRecord(pool: AuthPoolFile, record: AntigravityAuthRecord): AuthPoolFile {
  const lineage = record.lineage ?? randomUUID()
  if (pool.accounts.some(account => account.lineage === lineage)) return pool
  // The legacy record only ever held a masked address, so no identity tag can be derived
  // here. The adopted account keeps its lineage, which is the key rotation uses; it simply
  // cannot be matched by email until the user signs in again.
  return {
    ...pool,
    accounts: [...pool.accounts, {
      refreshToken: record.refreshToken,
      projectId: record.projectId,
      ...(record.email === undefined ? {} : { email: record.email }),
      lineage,
      addedAt: new Date().toISOString(),
    }],
    updatedAt: new Date().toISOString(),
  }
}

async function withPoolLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const parent = dirname(path)
  await prepareParent(parent)
  const lockPath = join(parent, POOL_LOCK_NAME)
  const deadline = Date.now() + POOL_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8')
        await handle.sync()
        return await operation()
      } finally {
        await handle.close().catch(() => {})
        await unlink(lockPath).catch(() => {})
      }
    } catch (error) {
      if (error instanceof AuthStoreError) throw error
      if (!isAlreadyExists(error)) throw new AuthStoreError('AUTH_STORE_IO', 'The Antigravity account pool could not be accessed')
      await removeStaleLock(lockPath)
      if (Date.now() >= deadline) throw new AuthStoreError('AUTH_STORE_CONFLICT', 'The Antigravity account pool is busy')
      await new Promise<void>(resolve => setTimeout(resolve, POOL_LOCK_RETRY_MS))
    }
  }
}

async function prepareParent(parent: string): Promise<void> {
  try {
    const info = await lstat(parent)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AuthStoreError('AUTH_STORE_UNSAFE_PERMISSIONS', 'The Antigravity account pool permissions are unsafe')
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await chmod(parent, 0o700)
  } catch (error) {
    if (error instanceof AuthStoreError) throw error
    throw new AuthStoreError('AUTH_STORE_IO', 'The Antigravity account pool could not be accessed')
  }
}

async function removeStaleLock(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (Date.now() - info.mtimeMs > POOL_LOCK_STALE_MS) await unlink(path).catch(() => {})
  } catch (error) {
    if (!isNotFound(error)) return
  }
}

async function assertOwnerOnly(path: string, platform: NodeJS.Platform): Promise<void> {
  const file = await lstat(path)
  const parent = await lstat(dirname(path))
  const unsafePosixMode = platform !== 'win32' && ((file.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0)
  if (file.isSymbolicLink() || parent.isSymbolicLink() || !parent.isDirectory() || unsafePosixMode) {
    throw new AuthStoreError('AUTH_STORE_UNSAFE_PERMISSIONS', 'The Antigravity account pool permissions are unsafe')
  }
}

function poolCorrupt(): AuthStoreError {
  return new AuthStoreError('AUTH_STORE_CORRUPT', 'The Antigravity account pool is not valid')
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
