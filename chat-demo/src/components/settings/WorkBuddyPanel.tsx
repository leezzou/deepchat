import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { FLASH_QUOTA_MODEL, onQuotaChange, readFlashMeter } from '../../services/workbuddy/quota.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  useConversationModes,
  getConversationMode,
} from '../../services/conversationMode/storage.js'
import { WORKBUDDY_PROFILE } from '../../services/workbuddy/models.js'
import {
  getWorkBuddyWallet,
  refreshWorkBuddyWallet,
  setWorkBuddyAutoCheckIn,
  type WorkBuddyWalletSnapshot,
} from '../../shell/workbuddy-wallet.js'
import { IconRefreshOutline16 } from '../base/icons.js'
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
  const revision = useWorkBuddyState(
    (s) => `${s.metadata?.revision ?? 'signed-out'}:${s.metadata?.model ?? ''}`
  )
  return (
    <div className="wb-settings" data-wb-panel>
      <WalletSection key={revision} />
    </div>
  )
}

function FlashQuota({ revision, defaultModel }: { revision: string; defaultModel?: string }) {
  const locale = useSettings((s) => resolveLocale(s.locale))
  const chatSource = useSettings((s) => s.chatSource)
  const activeId = useChatStore((s) => s.activeId)
  useConversationModes()
  const selected = getConversationMode(activeId)
  const forConversation =
    selected.profileId === WORKBUDDY_PROFILE || (!selected.profileId && chatSource === 'workbuddy')
  const model = forConversation ? (selected.model ?? defaultModel) : defaultModel
  const text = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
  const [, redraw] = useState(0)
  const now = Date.now()
  const { tokens, limit, dayEnd } = readFlashMeter({ revision, model: FLASH_QUOTA_MODEL }, now)
  const next = Math.min(dayEnd, limit?.resetAt ?? dayEnd)
  useEffect(() => {
    const update = () => redraw((v) => v + 1)
    const unsubscribe = onQuotaChange(update)
    const timeout = window.setTimeout(update, Math.max(1, next - Date.now()))
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearTimeout(timeout)
      document.removeEventListener('visibilitychange', update)
      unsubscribe()
    }
  }, [next])
  // Account defaults and individual conversations can choose different models. Keep an
  // explicitly labelled Flash observation accessible even after leaving that conversation.
  if (model !== FLASH_QUOTA_MODEL && tokens === null && !limit) {
    return null
  }
  const reset = limit?.resetAt
    ? new Date(limit.resetAt).toLocaleString(locale, { timeZoneName: 'short' })
    : limit?.localTime
  return (
    <div className="wb-row" data-wb-flash-quota>
      <div className="wb-label">
        {text('DeepSeek 4.1 Flash 日额度', 'DeepSeek 4.1 Flash daily quota')}
        <small className="wb-caption" role="status">
          {limit?.daily
            ? text('已达到今日额度上限', 'Daily quota reached')
            : text('腾讯未提供账号剩余量', 'WorkBuddy has not reported the remaining allowance')}
          {limit && !limit.daily && (
            <>
              <br />
              {text(
                '最近请求已达到用量上限',
                'WorkBuddy reported a usage limit on the last request'
              )}
            </>
          )}
          <br />
          {reset
            ? text('腾讯提示重置时间：', 'WorkBuddy reset time: ') +
              reset +
              (limit?.localTime ? text('（时区未注明）', ' (time zone unspecified)') : '')
            : text('重置时间：腾讯未提供', 'Reset time: not reported')}
          {tokens !== null && (
            <>
              <br />
              {text('本机今日已记录', 'Recorded on this device today: ')}{' '}
              {tokens.toLocaleString(locale)} tokens {text('（北京时间）', '(UTC+8)')}
            </>
          )}
        </small>
      </div>
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
    const resume = () => {
      if (!document.hidden) {
        void perform(getWorkBuddyWallet)
      }
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      active.current = false
      document.removeEventListener('visibilitychange', resume)
    }
  }, [perform])

  const checked = wallet?.checkIn === 'checked-in'
  const lastUpdate = wallet?.observedAt ? new Date(wallet.observedAt).toLocaleString(locale) : ''
  const balance = wallet?.balance
  const connected = wallet?.source === 'account'
  const hasCreditAccount = connected
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
        {connected && wallet.revision && (
          <FlashQuota revision={wallet.revision} defaultModel={wallet.model} />
        )}
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
