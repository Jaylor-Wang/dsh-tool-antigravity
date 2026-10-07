/**
 * Account list for the settings card: shows every signed-in account, which one is in use,
 * and lets the user switch or remove one.
 *
 * Rendered only when the Host reports an account pool. The single-record install keeps its
 * previous presentation, so this component is additive.
 */

import { useCallback, useState, type ReactNode } from 'react'
import type { AccountSummary } from '../status.ts'
import type { AntigravityAuthSettingsProps } from './AntigravityAuthSettings.tsx'

type Translate = AntigravityAuthSettingsProps['t']

export interface AccountListProps {
  readonly accounts: readonly AccountSummary[]
  readonly singleAccount: boolean
  readonly t: Translate
  readonly rpc: AntigravityAuthSettingsProps['rpc']
  /** Reload the status view after a successful operation. */
  readonly onChanged: () => void
}

/** Which account an operation is currently running against, if any. */
type PendingOperation = { readonly id: string; readonly kind: 'select' | 'remove' } | undefined

export function AccountList({ accounts, singleAccount, t, rpc, onChanged }: AccountListProps): ReactNode {
  const [pending, setPending] = useState<PendingOperation>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState('')

  const select = useCallback(async (id: string) => {
    if (rpc.selectAccount === undefined) return
    setPending({ id, kind: 'select' })
    setMessage('')
    const result = await rpc.selectAccount(id)
    if (result?.ok) {
      // One state change, then the parent refreshes at low priority. Writing the message
      // and clearing the marker separately would repaint the row once per write, which is
      // what made the switch look like a flicker.
      setPending(undefined)
      onChanged()
      return
    }
    setPending(undefined)
    setMessage(result?.error?.message ?? t('accountsUnknown'))
  }, [rpc, t, onChanged])

  const remove = useCallback(async (id: string) => {
    if (rpc.removeAccount === undefined) return
    setPending({ id, kind: 'remove' })
    setMessage('')
    const result = await rpc.removeAccount(id)
    if (result?.ok) {
      setPending(undefined)
      setConfirming(undefined)
      onChanged()
      return
    }
    setPending(undefined)
    setConfirming(undefined)
    setMessage(result?.error?.message ?? t('accountsUnknown'))
  }, [rpc, t, onChanged])

  if (singleAccount) {
    return (
      <div className="agy-accounts">
        <p className="agy-card-subtext">{t('accountsSingle')}</p>
      </div>
    )
  }

  return (
    <div className="agy-accounts">
      {accounts.length === 0 ? (
        <p className="agy-card-subtext">{t('accountsEmpty')}</p>
      ) : (
        <ul className="agy-account-list">
          {accounts.map(account => {
            const busy = pending?.id === account.id
            const confirmingThis = confirming === account.id
            return (
              <li key={account.id} className="agy-account-row" data-active={account.active ? 'true' : 'false'}>
                <div className="agy-account-identity">
                  <span className="agy-account-email">{account.email ?? t('accountsUnknown')}</span>
                  <span className="agy-account-state">
                    {account.active ? t('accountsActive') : null}
                    {account.active && account.coolingUntil !== undefined ? ' · ' : null}
                    {account.coolingUntil !== undefined ? coolingLabel(account.coolingUntil, t) : null}
                    {!account.active && account.coolingUntil === undefined ? t('accountsReady') : null}
                    {account.failureCount !== undefined && account.failureCount > 0
                      ? ` · ${account.failureCount} ${t('accountsFailures')}`
                      : null}
                  </span>
                </div>

                <div className="agy-account-actions">
                  {account.active ? null : (
                    <button
                      className="agy-btn agy-btn-outline agy-btn-small"
                      type="button"
                      disabled={busy}
                      onClick={() => { void select(account.id) }}
                    >
                      {busy && pending?.kind === 'select' ? t('accountsSwitching') : t('accountsUse')}
                    </button>
                  )}

                  {confirmingThis ? (
                    <>
                      <button
                        className="agy-btn agy-btn-danger agy-btn-small"
                        type="button"
                        disabled={busy}
                        onClick={() => { void remove(account.id) }}
                      >
                        {busy && pending?.kind === 'remove' ? t('accountsRemoving') : t('accountsRemoveConfirm')}
                      </button>
                      <button
                        className="agy-btn agy-btn-ghost agy-btn-small"
                        type="button"
                        disabled={busy}
                        onClick={() => { setConfirming(undefined) }}
                      >
                        {t('accountsRemoveCancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      className="agy-btn agy-btn-ghost agy-btn-small"
                      type="button"
                      disabled={busy}
                      onClick={() => { setConfirming(account.id) }}
                    >
                      {t('accountsRemove')}
                    </button>
                  )}
                </div>

                {confirmingThis ? <p className="agy-account-confirm">{t('accountsRemovePrompt')}</p> : null}
              </li>
            )
          })}
        </ul>
      )}

      {message === '' ? null : <p className="agy-card-subtext" role="status">{message}</p>}
    </div>
  )
}

/**
 * Render the remaining cooldown as a short, localized duration.
 *
 * Shown instead of an absolute timestamp because the useful question is "how long until this
 * account is eligible again", not "when exactly".
 */
function coolingLabel(coolingUntil: number, t: Translate): string {
  const remainingMs = coolingUntil - Date.now()
  if (remainingMs <= 0) return t('accountsReady')
  const minutes = Math.ceil(remainingMs / 60_000)
  if (minutes < 60) return `${t('accountsCooling')} ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${t('accountsCooling')} ${hours}h ${minutes % 60}m`
}
