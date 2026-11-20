import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { resolveLocale, useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useAccountIdentity } from '../../services/identity.js'
import { useSettings } from '../../services/settings.js'
import {
  getWorkBuddyWallet,
  refreshWorkBuddyWallet,
  setWorkBuddyAutoCheckIn,
  type WorkBuddyWalletSnapshot,
} from '../../shell/workbuddy-wallet.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { WorkBuddyChannel } from './WorkBuddyChannel.js'
import '../library/localSwitch.css'
import './workBuddyAccount.css'

export function WorkBuddyAccountPage() {
  const revision = useAccountIdentity().workbuddy?.revision
  return (
    <div className="wb-settings" data-wb-account-page>
      <WorkBuddyChannel>
        <WalletSection key={revision ?? 'signed-out'} revision={revision} />
      </WorkBuddyChannel>
    </div>
  )
}

const checkInText: Partial<Record<WorkBuddyWalletSnapshot['checkIn'], TranslationKey>> = {
  'checked-in': 'wbChecked',
  available: 'wbAvailable',
  inactive: 'wbInactive',
  ineligible: 'wbIneligible',
  'pending-confirmation': 'wbAwaiting',
}

function WalletSection({ revision }: { revision?: string }) {
  const t = useTranslate()
  const heading = useId()
  const locale = useSettings((s) => resolveLocale(s.locale))
  const [snapshot, setSnapshot] = useState<WorkBuddyWalletSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const active = useRef(true)
  const running = useRef(false)
  const perform = useCallback(async (op: () => Promise<WorkBuddyWalletSnapshot>) => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    setFailed(false)
    try {
      const value = await op()
      if (active.current) {
        setSnapshot(value)
      }
    } catch {
      if (active.current) {
        setFailed(true)
      }
    } finally {
      running.current = false
      if (active.current) {
        setBusy(false)
      }
    }
  }, [])
  const loadWallet = useCallback(async () => {
    const saved = await getWorkBuddyWallet()
    if (!active.current) {
      return saved
    }
    setSnapshot(saved)
    if (revision && saved.source === 'account' && saved.revision === revision) {
      return refreshWorkBuddyWallet()
    }
    return saved
  }, [revision])
  useEffect(() => {
    active.current = true
    if (revision) {
      void perform(loadWallet)
    }
    const resume = () => {
      if (revision && !document.hidden) {
        void perform(getWorkBuddyWallet)
      }
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      active.current = false
      document.removeEventListener('visibilitychange', resume)
    }
  }, [revision, loadWallet, perform])

  // A wallet response can race with auth. Never render the previous session’s observations.
  const wallet =
    revision && snapshot?.source === 'account' && snapshot.revision === revision ? snapshot : null
  const balance = wallet?.balance
  const amount =
    typeof balance === 'number' && Number.isFinite(balance)
      ? balance.toLocaleString(locale, { maximumFractionDigits: 6 })
      : '—'
  const lastUpdate =
    wallet?.observedAt &&
    new Date(wallet.observedAt).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  const caption = !revision
    ? t('wbSignInToView')
    : lastUpdate
      ? t('wbUpdated', { time: lastUpdate })
      : busy
        ? t('wbChecking')
        : ''
  const checkIn = wallet && checkInText[wallet.checkIn]
  const error =
    failed ||
    wallet?.state === 'unavailable' ||
    wallet?.state === 'access-denied' ||
    (revision && snapshot && !wallet)
  return (
    <section className="wb-group" aria-labelledby={heading} data-wb-wallet>
      <h3 className="wb-group-title" id={heading}>
        {t('wbAccountDetails')}
      </h3>
      <div className="wb-card">
        <div className="wb-row wb-balance" data-wb-balance aria-busy={busy}>
          <div className="wb-label">
            <span>{t('wbBalance')}</span>
            <output className="wb-credit-value" aria-label={t('wbBalance')} aria-live="polite">
              {amount}
            </output>
            {caption && <small className="wb-caption">{caption}</small>}
          </div>
          {revision && (
            <button
              type="button"
              className="wb-icon-button"
              disabled={busy}
              aria-label={t('wbRefresh')}
              title={t('wbRefresh')}
              onClick={() => void perform(loadWallet)}
            >
              <IconRefreshOutline16 />
            </button>
          )}
        </div>
        <label className="wb-row">
          <span className="wb-label">
            {t('wbAutoCheckIn')}
            {checkIn && (
              <small className="wb-caption" role="status">
                {t(checkIn)}
              </small>
            )}
          </span>
          <input
            className="dc-local-switch"
            type="checkbox"
            role="switch"
            data-wb-auto
            aria-label={t('wbAutoCheckIn')}
            checked={wallet?.autoCheckIn ?? false}
            disabled={!wallet?.canAutoCheckIn || busy}
            onChange={(event) => {
              const enabled = event.currentTarget.checked
              void perform(() => setWorkBuddyAutoCheckIn(enabled))
            }}
          />
        </label>
      </div>
      {error && (
        <p className="wb-status" role="status">
          {t(wallet?.state === 'access-denied' ? 'wbNoAccess' : 'wbWalletFailure')}
        </p>
      )}
      <p className="wb-status" data-wb-daily-limit-note>
        {t('wbDailyLimit')}
      </p>
    </section>
  )
}
