/** Host-side Antigravity risk gate, OAuth coordinator, and credential commit boundary. */

import { randomUUID, createHash } from 'node:crypto'
import type { AntigravityAuthRecord, AntigravityAuthStore } from './auth-store.ts'
import { createAuthStore, defaultAuthStorePath } from './auth-store.ts'
import { createAuthStorePool, defaultAuthPoolPath, effectiveFailureCount, emailTagFor, type AuthStorePool } from './auth-store-pool.ts'
import { decideRotation } from './rotation-policy.ts'
import { createCredentialCoordinator, type CredentialCoordinator, type CredentialCoordinatorOptions, type HostCredential } from './credential-coordinator.ts'
import { createOAuthFlow, OAuthFlowError } from './oauth-flow.ts'
import type {
  OAuthFlow,
  OAuthFlowCompletionResult,
  OAuthFlowOptions,
  OAuthToken,
  ProjectValidation,
} from './oauth-flow.ts'
import { createProjectDiscovery } from './project-context.ts'
import { isBoundedSafeText } from './safe-text.ts'
import type { ProjectDiscoveryOptions } from './project-context.ts'
import type {
  AntigravityStatusView,
  BootstrapStatusService,
  RiskAcknowledgementResult,
  LoginActionResult,
  LoginStartResult,
  LoginStatusView,
  CapabilityGateEvidence,
  LlmFamilyId,
} from './status.ts'
import { createStatusView } from './status.ts'
import { createQuotaService, type QuotaService, type QuotaServiceOptions } from './quota.ts'
import {
  createFileCapabilityGates,
  createMemoryCapabilityGates,
  defaultCapabilityGatePath,
  type CapabilityGateRegistry,
} from './capability-gates.ts'
import type { CapabilityGateOutcome, CapabilityRowId } from './status.ts'
import type { AccountSummary } from './status.ts'

/**
 * Opaque handle for one pooled account.
 *
 * The UI needs to name an account to act on it, but the lineage is the fence every other
 * decision keys on, so it is not handed to the browser. A hash is stable across status
 * reads, which is all the UI requires.
 */
export function accountHandle(lineage: string): string {
  return createHash('sha256').update(`dsh-tool-antigravity/handle/${lineage}`).digest('hex').slice(0, 32)
}

export interface AntigravityAuthServiceOptions {
  readonly store?: AntigravityAuthStore
  readonly storePath?: string
  readonly flowOptions?: Omit<OAuthFlowOptions, 'commit' | 'validateProject'>
  /** Inject a complete private transport only for deterministic Host tests. */
  readonly projectOptions?: ProjectDiscoveryOptions
  readonly credentialOptions?: Omit<CredentialCoordinatorOptions, 'store'>
  readonly quotaOptions?: Omit<QuotaServiceOptions, 'auth'>
  readonly gates?: CapabilityGateRegistry
  readonly gatePath?: string
  readonly autoActivateGates?: boolean
  /**
   * Sign in several accounts and rotate between them. On by default.
   * When enabled without an explicit `store`, the multi-account pool at `authPoolPath` is used.
   */
  readonly multiAccount?: boolean
  /** Pool file location; defaults to `accounts.json` beside the single-record store. */
  readonly authPoolPath?: string
}

export type { HostCredential } from './credential-coordinator.ts'

/** Outcome of an account-list operation the settings UI can invoke. */
export type AccountOperationResult =
  | { readonly state: 'selected' }
  | { readonly state: 'removed' }
  | { readonly state: 'unknown-account' }

export class AntigravityAuthService implements BootstrapStatusService {
  private readonly store: AntigravityAuthStore
  private readonly credentials: CredentialCoordinator
  private readonly flow: OAuthFlow
  private readonly quota: QuotaService
  private readonly gates: CapabilityGateRegistry
  private readonly autoActivate: boolean
  private readonly accounts: AuthStorePool | undefined
  private activeFamily: string | undefined
  private riskAcknowledged = false
  private activeFlowGeneration = 0
  private disposed = false
  private readonly statusListeners = new Set<() => void>()

  constructor(options: AntigravityAuthServiceOptions = {}) {
    this.autoActivate = options.autoActivateGates ?? false
    const storePath = options.storePath ?? defaultAuthStorePath()
    this.accounts = options.multiAccount !== false && options.store === undefined
      ? createAuthStorePool(options.authPoolPath ?? defaultAuthPoolPath(storePath), {
          family: () => this.activeFamily,
          // Adopt an existing single-account install on first use, without touching it.
          legacyStorePath: storePath,
        })
      : undefined
    this.store = options.store ?? this.accounts ?? createAuthStore(storePath)
    this.gates = options.gates ?? (options.gatePath !== undefined
      ? createFileCapabilityGates(options.gatePath)
      : options.store === undefined
        ? createFileCapabilityGates(defaultCapabilityGatePath(storePath))
        : createMemoryCapabilityGates())
    this.credentials = createCredentialCoordinator({
      ...options.credentialOptions,
      store: this.store,
      // Rotation is wired only for the pool. Passing a no-op report for the single-record
      // store would be misleading; leaving the hook unset keeps that path untouched.
      ...(this.accounts === undefined
        ? {}
        : { onRefreshFailure: report => this.rotateOnFailure(report) }),
    })
    this.quota = createQuotaService({
      ...options.quotaOptions,
      auth: this.credentials,
    })
    const projectDiscovery = createProjectDiscovery(options.projectOptions)
    this.flow = createOAuthFlow({
      ...options.flowOptions,
      validateProject: (accessToken, signal) => projectDiscovery.discover(accessToken, signal),
      commit: (token, project, signal) => this.commitCredential(token, project, signal),
    })
  }

  async status(): Promise<AntigravityStatusView> {
    const record = await this.readRecord()
    const flowStatus = this.flow.status()
    const phase = flowStatus.phase === 'idle' && record !== undefined ? 'success' : flowStatus.phase
    const maskedEmail = maskEmail(record?.email)
    const credentialStatus = await this.credentials.status()
    const gateEvidence = await this.gateEvidenceFor(record)
    const login: LoginStatusView = {
      phase,
      configured: record !== undefined,
      projectAvailable: record?.projectId !== undefined,
      ...(flowStatus.authorizationUrl === undefined ? {} : { authorizationUrl: flowStatus.authorizationUrl }),
      ...(flowStatus.expiresAt === undefined ? {} : { expiresAt: flowStatus.expiresAt }),
      ...(maskedEmail === undefined ? {} : { maskedEmail }),
      ...(flowStatus.errorCode === undefined ? {} : { errorCode: flowStatus.errorCode }),
    }
    return createStatusView(
      this.riskAcknowledged,
      login,
      credentialStatus,
      this.credentials.revokeStatus(),
      gateEvidence,
      await this.accountSummaries(record),
    )
  }

  /**
   * Build the value-safe account list for the settings UI.
   *
   * Returns `undefined` for the single-record store, which is what tells `createStatusView`
   * the install is not pooled. Each account is addressed by a hash of its lineage rather
   * than the lineage itself, so the identifier the browser holds cannot be replayed against
   * any other surface.
   */
  private async accountSummaries(
    active: AntigravityAuthRecord | undefined,
  ): Promise<readonly AccountSummary[] | undefined> {
    const pool = this.accounts
    if (pool === undefined) return undefined
    const state = await pool.readPool()
    const nowMs = Date.now()
    return state.accounts.map((account): AccountSummary => {
      // `maskEmail` returns undefined for an address it cannot render; the field is then
      // omitted rather than carried as an explicit undefined.
      const masked = account.email === undefined ? undefined : maskEmail(account.email)
      const cooling = account.cooldownUntil !== undefined && account.cooldownUntil > nowMs
        ? { coolingUntil: account.cooldownUntil }
        : {}
      // Report the live streak, not the stored counter: once the streak has aged out the UI
      // should stop calling an account failure-prone.
      const liveFailures = effectiveFailureCount(account, nowMs)
      const failures = liveFailures <= 0 ? {} : { failureCount: liveFailures }
      return {
        id: accountHandle(account.lineage),
        ...(masked === undefined ? {} : { email: masked }),
        active: active !== undefined && account.lineage === active.lineage,
        ...cooling,
        ...failures,
      }
    })
  }

  async acknowledgeRisk(): Promise<RiskAcknowledgementResult> {
    this.riskAcknowledged = true
    this.notifyStatus()
    return { acknowledged: true }
  }

  /** Observe value-safe gate changes so capability rows can register without polling secrets. */
  watchStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  async recordGate0(outcome: CapabilityGateOutcome): Promise<void> {
    const subject = gateSubject(await this.requireRecord())
    await this.gates.recordGate0(subject, outcome)
    this.notifyStatus()
  }

  async recordLlmFamilyGate(family: LlmFamilyId, outcome: CapabilityGateOutcome): Promise<void> {
    const record = await this.requireRecord()
    const subject = gateSubject(record)
    await this.gates.recordLlmFamily(subject, family, outcome)
    this.notifyStatus()
  }

  async recordCapabilityGate(id: CapabilityRowId, outcome: CapabilityGateOutcome): Promise<void> {
    const record = await this.requireRecord()
    const subject = gateSubject(record)
    if (id === 'auth-llm') {
      throw new OAuthFlowError('internal', 'Auth/LLM availability is derived from independent family evidence')
    }
    await this.gates.recordCapability(subject, id, outcome)
    this.notifyStatus()
  }

  async capabilityGateEvidence(): Promise<CapabilityGateEvidence> {
    return this.gateEvidenceFor(await this.readRecord())
  }

  /**
   * How many signed-in accounts a rotation may try. One for the single-record store, so
   * callers can use this as an attempt budget without special-casing the pool.
   */
  async accountCount(): Promise<number> {
    if (this.accounts === undefined) return (await this.readRecord()) === undefined ? 0 : 1
    return (await this.accounts.readPool()).accounts.length
  }

  /** Accounts that are not resting, which is what a rotation can actually pick from. */
  async readyAccountCount(): Promise<number> {
    if (this.accounts === undefined) return this.accountCount()
    return this.accounts.readyCount()
  }

  /**
   * Apply one refresh failure to the account pool and report what the caller should do.
   *
   * Rotation lives here rather than in the credential coordinator because only the pool
   * knows which account is current and how long it should rest. With the single-record
   * store there is nothing to rotate to, so the decision degrades to the same
   * stay/relogin advice without touching any file.
   */
  async rotateOnFailure(failure: {
    readonly reason?: string | undefined
    readonly message?: string | undefined
    readonly status?: number | undefined
    readonly retryAfterMs?: number | null
    readonly family?: string | undefined
  }): Promise<('rotate' | 'stay' | 'relogin' | 'exhausted')> {
    if (failure.family !== undefined) {
      this.activeFamily = failure.family
    }
    const record = await this.readRecord()
    if (record === undefined) return 'relogin'
    const pool = this.accounts
    if (pool === undefined) {
      const decision = decideRotation({ ...failure, consecutiveFailures: 0 })
      return decision.action
    }
    const current = (await pool.readPool()).accounts.find(account => account.lineage === record.lineage)
    const decision = decideRotation({
      ...failure,
      // Age out a stale streak: a failure hours after the last one is a fresh start, so the
      // ladder does not escalate against an account that has been fine in between.
      consecutiveFailures: current === undefined ? 0 : effectiveFailureCount(current, Date.now()),
    })
    if (decision.action !== 'rotate') return decision.action
    if (record.lineage !== undefined) {
      await pool.markCooldown(record.lineage, decision.cooldownMs, failure.family)
    }
    this.credentials.invalidateCache()
    this.notifyStatus()
    // Report exhaustion explicitly so a caller can surface "every account is resting"
    // instead of retrying against a pool that cannot serve the request.
    return (await pool.readyCount()) === 0 ? 'exhausted' : 'rotate'
  }

  /**
   * Make a pooled account the one the next request resolves to.
   *
   * Only meaningful with the pool: the single-record store has exactly one account, so the
   * request is rejected rather than silently doing nothing.
   */
  async selectAccount(handle: string): Promise<AccountOperationResult> {
    const pool = this.accounts
    if (pool === undefined) throw new OAuthFlowError('internal', 'This install does not use an account pool')
    const lineage = await this.resolveHandle(pool, handle)
    if (lineage === undefined) return { state: 'unknown-account' }
    // Selecting is a cursor move, not a credential write: the account must not be woken
    // from a cooldown, because it has not proven it can serve a request yet.
    await pool.setActive(lineage)
    this.credentials.invalidateCache()
    this.notifyStatus()
    return { state: 'selected' }
  }

  /**
   * Forget one pooled account.
   *
   * Removing the last account empties the pool, so `login` has to run again. The cached
   * access token is dropped when the removed account was the active one, so the next
   * request cannot keep using a credential whose account is gone.
   */
  async removeAccount(handle: string): Promise<AccountOperationResult> {
    const pool = this.accounts
    if (pool === undefined) throw new OAuthFlowError('internal', 'This install does not use an account pool')
    const lineage = await this.resolveHandle(pool, handle)
    if (lineage === undefined) return { state: 'unknown-account' }
    const removed = await pool.removeAccount(lineage)
    if (!removed) return { state: 'unknown-account' }
    this.credentials.invalidateCache()
    this.notifyStatus()
    return { state: 'removed' }
  }

  /** Map a UI handle back to the lineage it addresses, or undefined when unknown. */
  private async resolveHandle(pool: AuthStorePool, handle: string): Promise<string | undefined> {
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) return undefined
    const state = await pool.readPool()
    return state.accounts.find(account => accountHandle(account.lineage) === handle)?.lineage
  }

  async gate0Passed(): Promise<boolean> {
    return (await this.capabilityGateEvidence()).gate0?.outcome === 'passed'
  }

  async capabilityAvailable(id: CapabilityRowId): Promise<boolean> {
    const status = await this.status()
    return status.capabilities.some(capability => capability.id === id && capability.state === 'available')
  }

  async startLogin(): Promise<LoginStartResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    if (!this.riskAcknowledged) {
      throw new OAuthFlowError('risk-acknowledgement-required', 'Risk acknowledgement is required before login')
    }
    const started = await this.flow.start()
    this.activeFlowGeneration = this.flow.generation()
    this.notifyStatus()
    return started
  }

  async completeCallback(callbackUrl: string): Promise<OAuthFlowCompletionResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    try {
      return await this.flow.completeCallbackUrl(callbackUrl)
    } finally {
      this.notifyStatus()
    }
  }

  async cancelLogin(): Promise<LoginActionResult> {
    const status = await this.flow.cancel()
    if (status.phase !== 'success') this.activeFlowGeneration = 0
    this.notifyStatus()
    return {
      phase: status.phase,
      ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
    }
  }

  async credential(signal?: AbortSignal, options?: { readonly forceRefresh?: boolean; readonly family?: string }): Promise<HostCredential | undefined> {
    if (options?.family !== undefined) {
      this.activeFamily = options.family
    }
    return await this.credentials.credential(signal, options)
  }

  async usage(signal?: AbortSignal, force = false): Promise<import('./quota.ts').QuotaStatusView> {
    return await this.quota.refresh(signal, force)
  }

  async logout(): Promise<import('./credential-coordinator.ts').LogoutResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    this.activeFlowGeneration = 0
    await this.flow.cancel()
    try {
      const result = await this.credentials.logout()
      await this.gates.clear()
      this.notifyStatus()
      return result
    } catch {
      throw new OAuthFlowError('persistence-failed', 'The local Antigravity credential could not be cleared')
    }
  }

  async revoke(confirmed: boolean, signal?: AbortSignal): Promise<import('./credential-coordinator.ts').RevokeActionResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    const result = await this.credentials.revoke(confirmed, signal)
    if (result.state === 'revoked' || result.state === 'logged-out' || result.state === 'superseded') await this.gates.clear()
    this.notifyStatus()
    return result
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.activeFlowGeneration = 0
    this.statusListeners.clear()
    await Promise.all([this.flow.dispose(), this.credentials.dispose(), this.quota.dispose()])
  }

  private async commitCredential(token: OAuthToken, project: ProjectValidation, signal: AbortSignal): Promise<void> {
    const flowGeneration = this.flow.generation()
    if (this.disposed || flowGeneration !== this.activeFlowGeneration || signal.aborted) {
      throw new OAuthFlowError('cancelled', 'The OAuth login was cancelled')
    }
    const current = await this.readRecord()
    if (this.disposed || flowGeneration !== this.activeFlowGeneration || signal.aborted) {
      throw new OAuthFlowError('cancelled', 'The OAuth login was cancelled')
    }
    // The raw address reaches the store only so it can derive a masked display form and a
    // hashed identity tag; neither the pool nor the single-record store persists it. The
    // single-record path masks it here, which the existing privacy test pins down.
    const rawEmail = project.email ?? token.email
    const draft = {
      refreshToken: token.refreshToken,
      projectId: project.projectId,
      ...(rawEmail === undefined
        ? {}
        : { email: this.accounts === undefined ? (maskEmail(rawEmail) ?? rawEmail) : rawEmail }),
    }
    const committed = await this.commitLogin(current, draft)
    if (committed === undefined) throw new OAuthFlowError('credential-conflict', 'The login changed while it was completing')
    if (this.autoActivate) {
      const subject = committed.lineage ?? 'legacy-account'
      await this.autoActivateGates(subject)
    } else {
      // The lineage fence makes prior evidence unusable atomically with this commit.
      // Physical cleanup is best-effort: a stale file cannot authorize the new lineage.
      await this.gates.clear().catch(() => {})
    }
    // The persistent compare-and-commit is the linearization point. A later abort
    // cannot turn a committed replacement into a reported failed login.
    this.credentials.replaceFromLogin({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      projectId: project.projectId,
    }, committed)
    // The browser redirect commits through the flow's loopback listener, which
    // never reaches the public completeCallback wrapper. Publish the committed
    // credential here so capability lifecycles register the LLM/search/image/
    // video routes without a Host restart.
    this.notifyStatus()
  }

  /**
   * Persist one completed login, deciding whether it refreshes an existing account or
   * adds a new one.
   *
   * The distinction cannot come from the single-record store: it only ever holds one
   * account, so `compareAndCommit` with the observed lineage means "replace". The pool
   * instead keys on a hashed identity tag — signing in with the same address refreshes
   * that account, a new address joins the pool. The raw address is used only to compute
   * the tag and is never written.
   */
  private async commitLogin(
    current: AntigravityAuthRecord | undefined,
    draft: { readonly refreshToken: string; readonly projectId: string; readonly email?: string },
  ): Promise<AntigravityAuthRecord | undefined> {
    const pool = this.accounts
    if (pool === undefined) {
      // Single-record semantics are unchanged: the observed lineage fences the write.
      return await this.store.compareAndCommit(current?.revision ?? 0, draft, current?.lineage)
    }
    const state = await pool.readPool()
    const tag = emailTagFor(draft.email)
    const existing = tag === undefined
      ? undefined
      : state.accounts.find(account => account.emailTag === tag)
    // A known account is updated in place, keeping the line so the caller's cached
    // credential and gate evidence stay valid. An unknown account is given a fresh line and
    // written with no *observed* lineage, which is the pool's append shape. Passing the new
    // lineage as the observed one would instead demand an account that does not exist yet.
    if (existing !== undefined) {
      return await pool.compareAndCommit(state.revision, { ...draft, lineage: existing.lineage }, existing.lineage)
    }
    return await pool.compareAndCommit(state.revision, { ...draft, lineage: randomUUID() }, undefined)
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) {
      try { listener() } catch { /* observer failures cannot change auth state */ }
    }
  }

  private async gateEvidenceFor(record: AntigravityAuthRecord | undefined): Promise<CapabilityGateEvidence> {
    try {
      const evidence = await this.gates.read()
      if (record === undefined) return {}
      const subject = gateSubject(record)
      if (evidence.subject === subject) return evidence

      if (this.autoActivate && record.projectId !== undefined) {
        await this.autoActivateGates(subject)
        return await this.gates.read()
      }
      return {}
    } catch {
      return { gate0: { outcome: 'protocol-drift', checkedAt: new Date().toISOString() } }
    }
  }

  private async autoActivateGates(subject: string): Promise<void> {
    try {
      await this.gates.recordGate0(subject, 'passed')
      await this.gates.recordLlmFamily(subject, 'gemini', 'passed')
      await this.gates.recordLlmFamily(subject, 'claude', 'passed')
      await this.gates.recordLlmFamily(subject, 'gpt-oss', 'passed')
      await this.gates.recordCapability(subject, 'image', 'passed')
    } catch {
      // Best-effort auto-activation
    }
  }

  private async requireRecord(): Promise<AntigravityAuthRecord> {
    const record = await this.readRecord()
    if (record === undefined) throw new OAuthFlowError('internal', 'Antigravity login is required')
    return record
  }

  private async readRecord(): Promise<AntigravityAuthRecord | undefined> {
    try {
      return await this.store.read()
    } catch {
      throw new OAuthFlowError('persistence-failed', 'The Antigravity auth store could not be read')
    }
  }
}

function gateSubject(record: AntigravityAuthRecord): string {
  return record.lineage ?? 'legacy-account'
}

export function createAntigravityAuthService(options: AntigravityAuthServiceOptions = {}): AntigravityAuthService {
  return new AntigravityAuthService(options)
}

export function maskEmail(value: string | undefined): string | undefined {
  if (!isBoundedSafeText(value, 4096)) return undefined
  const at = value.indexOf('@')
  if (at <= 0 || at === value.length - 1) return undefined
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (!/^[^\s@]+$/u.test(local) || !/^[^\s@]+$/u.test(domain)) return undefined
  if (local.endsWith('***')) return `${local}@${domain}`
  const head = local.slice(0, 1)
  const tail = local.length > 1 ? local.slice(-1) : ''
  return `${head}***${tail}@${domain}`
}
