/** Browser half of the private Antigravity bootstrap capability bundle. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createAntigravityAuthRpcClient } from '../rpc-contract.ts'
import { AntigravityAuthSettings } from './AntigravityAuthSettings.tsx'
import { en, zh, type AntigravityAuthKey } from './locales.ts'
import type { AntigravityAuthSettingsProps } from './AntigravityAuthSettings.tsx'
import type { AntigravityImageSettings } from '../image.ts'

const NS = 'settings.antigravityAuth'

export { AntigravityAuthSettings } from './AntigravityAuthSettings.tsx'
export type { AntigravityAuthSettingsProps } from './AntigravityAuthSettings.tsx'
export { en, zh } from './locales.ts'
export type { AntigravityAuthKey } from './locales.ts'

/** Client services required by the settings section and its loopback RPC. */
export const inject = ['slots', 'locale', 'connection']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the Antigravity bootstrap settings section. */
    'settings.antigravityAuth': AntigravityAuthKey
  }
}

/** Register one disposable settings section and no capability controls. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'antigravity-auth: copy dictionaries')

  const connection = ctx.get('connection') as unknown as ConnectionHandle
  if (!connection.isLoopback) return
  const rpc = createAntigravityAuthRpcClient(connection.rpc)
  const t = ctx.locale.bind(NS) as AntigravityAuthSettingsProps['t']
  const context = ctx as ClientContext & {
    configForms?: { get<T>(namespace: string): unknown }
    settingsScope?: { bind<T>(spec: { namespace: string; decode?: (value: unknown) => T | undefined }): unknown }
  }
  const imageScope = (context.configForms?.get
    ? context.configForms.get('antigravity-image')
    : context.settingsScope?.bind({ namespace: 'antigravity-image', decode: decodeImageSettings })
  ) as SettingsScope<AntigravityImageSettings> | undefined
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const reset = (): void => {
    for (const listener of listeners) listener()
  }
  ctx.effect(() => ctx.on('connection/reset', reset), 'antigravity-auth: connection invalidation')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'antigravity-auth',
    order: 20,
    label: () => t('nav'),
    inject: (): AntigravityAuthSettingsProps => ({ rpc, t, subscribe, imageScope }),
  }, AntigravityAuthSettings))
}

function decodeImageSettings(value: unknown): AntigravityImageSettings | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || typeof value.model !== 'string' || value.model.length === 0 || !positiveInteger(value.n) || value.n > 4) return undefined
  return { enabled: value.enabled, model: value.model, n: value.n }
}


function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
