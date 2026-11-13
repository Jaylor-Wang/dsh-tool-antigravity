/** Human-invocable /antigravity-models command to refresh or inspect models. */

import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AntigravityAuthService } from './auth-service.ts'
import { ACCOUNT_COMMAND_DENIED_MESSAGE, type LoopbackRpcMode } from './loopback-rpc.ts'
import {
  resolveAntigravityModelCatalog,
  type AntigravityModelCatalogService,
  type AntigravityModelCatalogView,
} from './model-catalog.ts'

type ModelsCommandService = Pick<AntigravityAuthService, 'status'>

/** Format model catalog status and available model ids without exposing secrets. */
export function formatAntigravityModelsResult(
  catalog: AntigravityModelCatalogView,
  gateReady: boolean,
  refreshed: boolean,
): CommandResult {
  const available = catalog.models.filter(model => model.state !== 'unavailable')
  const unavailableCount = catalog.models.length - available.length
  const filteredNote = unavailableCount > 0 ? ` (${unavailableCount} unavailable filtered)` : ''
  const checkedNote = catalog.checkedAt ? `, checked ${catalog.checkedAt}` : ''

  let header: string
  if (!gateReady) {
    header = `Antigravity models (snapshot; login or Gate 0 not ready — the model list may not be up to date / 列表可能不是最新): ${available.length} available`
  } else if (catalog.state === 'live-available') {
    header = `Antigravity models ${refreshed ? 'refreshed (live' : '(live'}${checkedNote}): ${available.length} available${filteredNote}`
  } else {
    const source = catalog.cached ? 'cached fallback' : 'known snapshot fallback'
    header = `Antigravity models (${catalog.state}, ${source}${checkedNote} — the model list may not be up to date / 列表可能不是最新): ${available.length} available${filteredNote}`
  }

  const lines = available.map(model => `- ${model.id} (${model.name})`)
  return {
    kind: 'success',
    text: lines.length > 0 ? `${header}\n${lines.join('\n')}` : header,
  }
}

/** Register the `/antigravity-models [refresh|list]` Host command. */
export function createAntigravityModelsCommand(
  service: ModelsCommandService,
  catalog: AntigravityModelCatalogService,
  accountMode: () => LoopbackRpcMode,
  onCatalogUpdated?: () => void,
): CommandDefinition {
  return {
    name: 'antigravity-models',
    description: 'Refresh or inspect available Antigravity models',
    input: { hint: '[refresh|list]' },
    handler: async ({ rawInput, signal }) => {
      if (accountMode() === 'blocked') {
        return { kind: 'error', text: ACCOUNT_COMMAND_DENIED_MESSAGE }
      }
      const operation = rawInput.trim().toLowerCase()
      if (operation !== '' && operation !== 'refresh' && operation !== 'list' && operation !== 'status') {
        return { kind: 'error', text: `unknown operation "${operation}" (available: refresh, list)` }
      }
      const forceRefresh = operation === '' || operation === 'refresh'
      try {
        const result = await resolveAntigravityModelCatalog(service, catalog, {
          signal,
          forceRefresh,
          onUpdated: onCatalogUpdated,
        })
        return formatAntigravityModelsResult(result.catalog, result.gateReady, forceRefresh)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return {
          kind: 'error',
          text: `${forceRefresh ? 'refreshing' : 'reading'} Antigravity models failed: ${detail}`,
        }
      }
    },
  }
}
