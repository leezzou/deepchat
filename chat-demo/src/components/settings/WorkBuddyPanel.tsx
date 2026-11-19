import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useWorkBuddyState } from '../../services/workbuddy/provider.js'
import {
  getWorkBuddyWallet,
  refreshWorkBuddyWallet,
  setWorkBuddyAutoCheckIn,
  type WorkBuddyWalletSnapshot,
} from '../../shell/workbuddy-wallet.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { WorkBuddyChannel } from './WorkBuddyChannel.js'
import '../library/localSwitch.css'
import './securitySettings.css'
import './workBuddyPanel.css'

/** An interrupted sequence should never carry over from another visit to Settings. */
export function WorkBuddyVersion({ version, onOpen }: { version: string; onOpen: () => void }) {
  const t = useTranslate()
  const sequence = useRef({ last: 0, count: 0 })
  return (
    <div className="wb-version-footer">
      <button
        type="button"
        data-wb-version
        onClick={() => {
          const now = performance.now()
          const count = now - sequence.current.last < 1200 ? sequence.current.count + 1 : 1
          sequence.current = { last: now, count: count === 7 ? 0 : count }
          if (count === 7) {
            onOpen()
          }
        }}
      >
        {t('settingsVersion', { version })}
      </button>
    </div>
  )
}

export function WorkBuddyPanel() {
  const revision = useWorkBuddyState((s) => s.metadata?.revision ?? 'signed-out')
  return (
    <div className="wb-settings" data-wb-panel>
      <WorkBuddyChannel />
      <WalletSection key={revision} />
    </div>
  )
}

function WalletSection() {
  const locale = useSettings((s) => resolveLocale(s.locale))
  const text = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
  const [wallet, setWallet] = useState<WorkBuddyWalletSnapshot | null>(null)
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
        setWallet(value)
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
  useEffect(() => {
    active.current = true
    void perform(async () => {
      const saved = await getWorkBuddyWallet()
      if (active.current) {
        setWallet(saved)
      }
      return saved.source === 'account' ? refreshWorkBuddyWallet() : saved
    })
    return () => {
      active.current = false
    }
  }, [perform])

  const checked = wallet?.checkIn === 'checked-in'
  const lastUpdate = wallet?.observedAt ? new Date(wallet.observedAt).toLocaleString(locale) : ''
  const balance = wallet?.balance
  const connected = useWorkBuddyState((s) => Boolean(s.metadata))
  const hasCreditAccount = connected && wallet?.source === 'account'
  const canRefresh = connected && !busy
  const observedBalance =
    hasCreditAccount && typeof balance === 'number' && Number.isFinite(balance)
  const balanceCaption = !connected
    ? text('登录后显示', 'Sign in to view')
    : observedBalance && lastUpdate
      ? text('更新于 ', 'Updated ') + lastUpdate
      : busy
        ? text('正在读取…', 'Checking…')
        : ''
  const checkedText = checked
    ? text('今日已签到', 'Checked in today')
    : wallet?.checkIn === 'available'
      ? text('今日可签到', 'Available today')
      : wallet?.checkIn === 'inactive'
        ? text('当前没有签到活动', 'No active check-in event')
        : wallet?.checkIn === 'ineligible'
          ? text(
              '腾讯未允许此账号或通道签到',
              'WorkBuddy declined check-in for this account or channel'
            )
          : wallet?.checkIn === 'pending-confirmation'
            ? text('等待腾讯确认，今日不会重复提交', 'Awaiting confirmation from WorkBuddy')
            : ''
  return (
    <section className="wb-group" aria-labelledby="wb-wallet-heading">
      <h3 className="wb-group-title" id="wb-wallet-heading">
        {text('我的积分', 'My credits')}
      </h3>
      <div className="wb-card">
        <div className="wb-row" data-wb-balance aria-busy={busy}>
          <div className="wb-label">
            {text('剩余积分', 'Available credits')}
            {balanceCaption && <small className="wb-caption">{balanceCaption}</small>}
          </div>
          <output
            className="wb-credit-value"
            aria-label={text('剩余积分', 'Available credits')}
            aria-live="polite"
          >
            {observedBalance ? balance.toLocaleString(locale, { maximumFractionDigits: 6 }) : '—'}
          </output>
          {connected && (
            <button
              type="button"
              className="wb-icon-button"
              disabled={!canRefresh}
              aria-label={text('刷新积分', 'Refresh credits')}
              onClick={() => void perform(refreshWorkBuddyWallet)}
            >
              <IconRefreshOutline16 />
            </button>
          )}
        </div>
        <label className="wb-row">
          <span className="wb-label">
            {text('每日自动签到', 'Daily automatic check-in')}
            {checkedText && (
              <small className="wb-caption" role="status">
                {checkedText}
              </small>
            )}
          </span>
          <input
            className="dc-local-switch"
            type="checkbox"
            role="switch"
            data-wb-auto
            aria-label={text('每日自动签到', 'Daily automatic check-in')}
            checked={wallet?.autoCheckIn ?? false}
            disabled={!wallet?.canAutoCheckIn || busy}
            onChange={(e) => {
              const enabled = e.currentTarget.checked
              void perform(() => setWorkBuddyAutoCheckIn(enabled))
            }}
          />
        </label>
      </div>
      {(failed || wallet?.state === 'unavailable' || wallet?.state === 'access-denied') && (
        <p className="wb-status" role="status">
          {wallet?.state === 'access-denied'
            ? text(
                '腾讯未授权读取此账号的积分。',
                'WorkBuddy declined access to this account’s credits.'
              )
            : text(
                '暂时无法更新积分，请稍后刷新。',
                'Could not update credits. Try refreshing later.'
              )}
        </p>
      )}
    </section>
  )
}
