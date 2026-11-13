/** Browser-safe advisory model-catalog state shared by Host RPC and settings. */

import type { AntigravityStatusView } from './status.ts'

export const ANTIGRAVITY_MODEL_CATALOG_STATES = [
  'snapshot',
  'live-available',
  'refresh-failed',
  'protocol-drift',
] as const

export type AntigravityModelCatalogState = (typeof ANTIGRAVITY_MODEL_CATALOG_STATES)[number]
export type AntigravityModelAvailability = 'snapshot' | 'live-available' | 'unavailable'

export interface AntigravityModelCatalogEntry {
  readonly id: string
  readonly name: string
  readonly state: AntigravityModelAvailability
}

export interface AntigravityModelCatalogView {
  readonly state: AntigravityModelCatalogState
  readonly models: readonly AntigravityModelCatalogEntry[]
  readonly checkedAt?: string
  readonly cached?: boolean
}

export interface AntigravityModelCatalogService {
  catalogSnapshot(): AntigravityModelCatalogView
  modelCatalog(signal?: AbortSignal, forceRefresh?: boolean): Promise<AntigravityModelCatalogView>
  invalidateModelCatalog?(clearPersisted?: boolean): void
}

/** Whether account login and Gate 0/LLM capability checks allow live catalog discovery. */
export function isAntigravityCatalogGateReady(
  status: Pick<AntigravityStatusView, 'login' | 'capabilities'>,
): boolean {
  return status.login.projectAvailable
    && status.capabilities.some(capability => capability.id === 'auth-llm' && capability.state === 'available')
}

/** Resolve the live catalog when Gate 0/LLM is ready, or fall back to the pinned snapshot. */
export async function resolveAntigravityModelCatalog(
  statusService: { status(): Promise<Pick<AntigravityStatusView, 'login' | 'capabilities'>> },
  catalogService: AntigravityModelCatalogService,
  options?: {
    readonly signal?: AbortSignal | undefined
    readonly forceRefresh?: boolean | undefined
    readonly onUpdated?: (() => void) | undefined
  },
): Promise<{ readonly gateReady: boolean; readonly catalog: AntigravityModelCatalogView }> {
  const status = await statusService.status()
  if (!isAntigravityCatalogGateReady(status)) {
    return { gateReady: false, catalog: catalogService.catalogSnapshot() }
  }
  const catalog = await catalogService.modelCatalog(options?.signal, options?.forceRefresh)
  if (options?.forceRefresh === true) options.onUpdated?.()
  return { gateReady: true, catalog }
}
