import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { resolveLocale, useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useAccountIdentity } from '../../services/identity.js'
import { useSettings } from '../../services/settings.js'
import {
  activateWorkBuddy,
  cancelWorkBuddySignIn,
  completeWorkBuddy,
  disconnectWorkBuddy,
  hasWorkBuddyBridge,
  refreshWorkBuddy,
  selectWorkBuddyModel,
  signInWorkBuddy,
  useWorkBuddyState,
} from '../../services/workbuddy/provider.js'
import { Button } from '../base/Button.js'
import { AccountAvatar } from './AccountAvatar.js'
import { WorkBuddyModelPicker } from './WorkBuddyModelPicker.js'

const loginErrors: Record<string, TranslationKey> = {
  desktop_browser_unavailable: 'wbBrowserUnavailable',
  login_expired: 'wbLoginExpired',
  connection_or_storage: 'wbRequestFailed',
  timeout: 'wbRequestFailed',
  personal_account_required: 'wbPersonalRequired',
}

export function WorkBuddyChannel({ children }: { children: ReactNode }) {
  const t = useTranslate()
  const en = useSettings((s) => resolveLocale(s.locale) !== 'zh-CN')
  const active = useSettings((s) => s.chatSource === 'workbuddy')
  const { metadata, pending } = useWorkBuddyState()
  const { workbuddy } = useAccountIdentity()
  const chatHeading = useId()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const running = useRef(false)
  const run = useCallback(async (op: () => Promise<void>) => {
    if (running.current) {
      return
    }
    running.current = true
    setError('')
    setBusy(true)
    try {
      await op()
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      running.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    if (hasWorkBuddyBridge) {
      void run(refreshWorkBuddy)
    }
    return () => {
      mounted.current = false
    }
  }, [run])
  useEffect(() => {
    if (!pending || error) {
      return
    }
    const poll = () => {
      if (!document.hidden) {
        void run(completeWorkBuddy)
      }
    }
    const timer = window.setInterval(poll, 3000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [pending, error, run])
  const errorKey = loginErrors[error.replace(/^WorkBuddy · /, '')]
  return (
    <>
      <header className="wb-account-header">
        <AccountAvatar
          key={workbuddy?.revision}
          source="workbuddy"
          avatar={workbuddy?.avatar}
          large
        />
        <div className="wb-identity">
          <h2 dir="auto">{workbuddy?.name || 'WorkBuddy'}</h2>
          <p>{t(workbuddy ? 'wbPersonalAccount' : pending ? 'wbPending' : 'wbSignedOut')}</p>
        </div>
        <Button
          className="wb-session-action"
          data-login={!workbuddy && !pending ? '' : undefined}
          variant={workbuddy || pending ? 'outlined' : 'primary'}
          size="s"
          disabled={busy || !hasWorkBuddyBridge}
          onClick={() => {
            if (workbuddy) {
              void run(disconnectWorkBuddy)
            } else {
              void run(pending ? cancelWorkBuddySignIn : signInWorkBuddy)
            }
          }}
        >
          {t(workbuddy ? 'wbSignOut' : pending ? 'cancel' : 'wbDesktopSignIn')}
        </Button>
      </header>
      {error && (
        <p className="wb-status" role="alert">
          {errorKey ? t(errorKey) : error}
        </p>
      )}
      {!workbuddy && (
        <p className="wb-status">
          {t(!hasWorkBuddyBridge ? 'accountAppOnly' : pending ? 'wbApprovalHint' : 'wbLoginHint')}
        </p>
      )}
      {children}
      {workbuddy && metadata && (
        <section className="wb-group" aria-labelledby={chatHeading}>
          <h3 id={chatHeading} className="wb-group-title">
            {t('wbChats')}
          </h3>
          <div className="wb-card">
            <div className="wb-row wb-model-field">
              <span className="wb-label">{t('wbModel')}</span>
              <WorkBuddyModelPicker
                disabled={busy}
                en={en}
                label={t('wbModelName')}
                value={metadata.model}
                onChange={(model) => void run(() => selectWorkBuddyModel(model))}
              />
            </div>
            <label className="wb-row">
              <span className="wb-label">{t('wbUseForChats')}</span>
              <input
                className="dc-local-switch"
                type="checkbox"
                role="switch"
                checked={active}
                disabled={busy}
                onChange={(e) => activateWorkBuddy(e.currentTarget.checked)}
              />
            </label>
          </div>
        </section>
      )}
    </>
  )
}
