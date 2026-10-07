/** Value-free login and capability status shared by Host and browser code. */

import type { LoginActionResult, LoginCompletionResult, LoginErrorCode, LoginPhase, LoginStartResult, LoginStatusView } from './login-types.ts'
import type { CredentialStatusView, LogoutResult, RevokeActionResult, RevokeStatusView } from './credential-coordinator.ts'
import type { QuotaStatusView } from './quota.ts'

export const ANTIGRAVITY_PLUGIN_ID = 'dsh-tool-antigravity' as const
export const CAPABILITY_ROW_IDS = ['auth-llm', 'image'] as const
export const LLM_FAMILY_IDS = ['gemini', 'claude', 'gpt-oss'] as const

export type CapabilityRowId = (typeof CAPABILITY_ROW_IDS)[number]
export type LlmFamilyId = (typeof LLM_FAMILY_IDS)[number]
export type CapabilityGateState = 'available' | 'disabled' | 'poc-pending' | 'protocol-drift'
export type CapabilityGateReasonCode =
  | 'gate-not-run'
  | 'project-unavailable'
  | 'capability-ready'
  | 'unauthenticated'
  | 'rate-limited'
  | 'cancelled'
  | 'gate-0-failed'
  | 'gate-failed'
  | 'protocol-drift'
export const CAPABILITY_GATE_OUTCOMES = [
  'passed',
  'unauthenticated',
  'rate-limited',
  'cancelled',
  'attribution-rejected',
  'protocol-drift',
  'failed',
] as const

export type CapabilityGateOutcome = (typeof CAPABILITY_GATE_OUTCOMES)[number]

export interface CapabilityGateResult {
  readonly outcome: CapabilityGateOutcome
  readonly checkedAt: string
}

export interface CapabilityGateEvidence {
  /** Credential-lineage fence; evidence from another account is ignored. */
  readonly subject?: string
  readonly gate0?: CapabilityGateResult
  readonly llmFamilies?: Readonly<Partial<Record<LlmFamilyId, CapabilityGateResult>>>
  readonly capabilities?: Readonly<Partial<Record<CapabilityRowId, CapabilityGateResult>>>
}
export type { LoginActionResult, LoginErrorCode, LoginPhase, LoginStartResult, LoginStatusView }

export interface CapabilityGateStatus {
  readonly id: CapabilityRowId
  readonly state: CapabilityGateState
  readonly reasonCode: CapabilityGateReasonCode
}

/**
 * One signed-in account as the settings UI is allowed to see it.
 *
 * Deliberately value-safe: the address is masked, and the identity tag is a hash, so this
 * crosses the Host/browser boundary without carrying anything that identifies the account
 * on its own. No token, no refresh token, no raw address.
 */
export interface AccountSummary {
  /** Opaque handle the UI uses to address this account in an operation. */
  readonly id: string
  /** Masked address for display, or absent when the account predates identity capture. */
  readonly email?: string
  /** True for the account a credential request would currently resolve to. */
  readonly active: boolean
  /** Epoch ms until which rotation skips this account; absent when it is ready. */
  readonly coolingUntil?: number
  /** Consecutive rotation failures, so the UI can show a struggling account. */
  readonly failureCount?: number
}

export interface AntigravityStatusView {
  readonly pluginId: typeof ANTIGRAVITY_PLUGIN_ID
  readonly phase: 'bootstrap'
  readonly privateSelfUse: true
  /**
   * True only while the install runs the single-record store. When the account pool is
   * enabled this is false and `accounts` carries the pool, so the UI can render either
   * shape from one contract.
   */
  readonly singleAccount: boolean
  readonly riskAcknowledgementRequired: true
  readonly riskAcknowledged: boolean
  readonly login: LoginStatusView
  /** Every signed-in account, in pool order. Empty for the single-record store. */
  readonly accounts: readonly AccountSummary[]
  /** Credential state is value-safe; tokens and grant errors never cross this boundary. */
  readonly credential?: CredentialStatusView
  readonly revoke?: RevokeStatusView
  readonly capabilities: readonly CapabilityGateStatus[]
}

export interface RiskAcknowledgementResult {
  readonly acknowledged: true
}

export interface BootstrapStatusService {
  status(): Promise<AntigravityStatusView>
  acknowledgeRisk(): Promise<RiskAcknowledgementResult>
  startLogin(): Promise<LoginStartResult>
  completeCallback(callbackUrl: string): Promise<LoginCompletionResult>
  cancelLogin(): Promise<{ readonly phase: LoginPhase; readonly errorCode?: LoginErrorCode }>
  logout(): Promise<LogoutResult>
  revoke(confirmed: boolean, signal?: AbortSignal): Promise<RevokeActionResult>
  usage?(signal?: AbortSignal, force?: boolean): Promise<QuotaStatusView>
  dispose(): Promise<void>
}

const CAPABILITY_DEFINITIONS: readonly CapabilityGateStatus[] = Object.freeze(
  CAPABILITY_ROW_IDS.map(id => Object.freeze({ id, state: 'disabled' as const, reasonCode: 'unauthenticated' as const })),
)

const PROJECT_DISCOVERY_FAILURES = new Set([
  'project-unavailable',
  'project-authentication-failed',
  'project-forbidden',
  'project-rate-limited',
  'project-offline',
  'project-malformed',
  'project-protocol-drift',
])

export function createStatusView(
  riskAcknowledged: boolean,
  login: LoginStatusView,
  credential?: CredentialStatusView,
  revoke?: RevokeStatusView,
  gates: CapabilityGateEvidence = {},
  accounts?: readonly AccountSummary[],
): AntigravityStatusView {
  const pool = accounts === undefined ? undefined : Object.freeze(accounts.map(account => Object.freeze({ ...account })))
  return Object.freeze({
    pluginId: ANTIGRAVITY_PLUGIN_ID,
    phase: 'bootstrap',
    privateSelfUse: true,
    // The pool is authoritative when present: an install running it is no longer
    // single-account even if only one account happens to be signed in.
    singleAccount: pool === undefined,
    riskAcknowledgementRequired: true,
    riskAcknowledged,
    login: Object.freeze({ ...login }),
    accounts: pool ?? Object.freeze([]),
    ...(credential === undefined ? {} : { credential: Object.freeze({ ...credential }) }),
    ...(revoke === undefined ? {} : { revoke: Object.freeze({ ...revoke }) }),
    capabilities: Object.freeze(capabilitiesFor(login, gates).map(capability => Object.freeze({ ...capability }))),
  })
}

function capabilitiesFor(login: LoginStatusView, gates: CapabilityGateEvidence): readonly CapabilityGateStatus[] {
  const projectBlocked = !login.projectAvailable
    && (login.configured
      || (login.errorCode !== undefined && PROJECT_DISCOVERY_FAILURES.has(login.errorCode)))
  if (projectBlocked) return CAPABILITY_DEFINITIONS.map(capability => ({
    id: capability.id,
    state: 'disabled' as const,
    reasonCode: 'project-unavailable' as const,
  }))
  if (!login.projectAvailable) return CAPABILITY_DEFINITIONS
  if (gates.gate0?.outcome !== 'passed') {
    return CAPABILITY_ROW_IDS.map(id => gate0Status(id, gates.gate0))
  }
  return CAPABILITY_ROW_IDS.map(id => gateStatus(
    id,
    id === 'auth-llm' ? llmFamilyResult(gates) : gates.capabilities?.[id],
  ))
}

function llmFamilyResult(gates: CapabilityGateEvidence): CapabilityGateResult | undefined {
  const results = LLM_FAMILY_IDS.map(family => gates.llmFamilies?.[family])
  const failure = results.find(result => result !== undefined && result.outcome !== 'passed')
  if (failure !== undefined) return failure
  if (results.some(result => result?.outcome !== 'passed')) return undefined
  return results.reduce((latest, result) => (
    latest === undefined || Date.parse(result!.checkedAt) > Date.parse(latest.checkedAt) ? result : latest
  ), undefined as CapabilityGateResult | undefined)
}

function gate0Status(id: CapabilityRowId, result: CapabilityGateResult | undefined): CapabilityGateStatus {
  if (result?.outcome === 'failed' || result?.outcome === 'attribution-rejected') {
    return { id, state: 'disabled', reasonCode: 'gate-0-failed' }
  }
  return gateStatus(id, result)
}

function gateStatus(id: CapabilityRowId, result: CapabilityGateResult | undefined): CapabilityGateStatus {
  if (result === undefined) return { id, state: 'poc-pending', reasonCode: 'gate-not-run' }
  if (result.outcome === 'passed') return { id, state: 'available', reasonCode: 'capability-ready' }
  if (result.outcome === 'protocol-drift') return { id, state: 'protocol-drift', reasonCode: 'protocol-drift' }
  if (result.outcome === 'attribution-rejected') return { id, state: 'disabled', reasonCode: 'gate-0-failed' }
  if (result.outcome === 'unauthenticated') return { id, state: 'disabled', reasonCode: 'unauthenticated' }
  if (result.outcome === 'rate-limited') return { id, state: 'disabled', reasonCode: 'rate-limited' }
  if (result.outcome === 'cancelled') return { id, state: 'disabled', reasonCode: 'cancelled' }
  return { id, state: 'disabled', reasonCode: 'gate-failed' }
}
