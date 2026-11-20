import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveLocale } from '../../i18n/index.js'
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
import { WorkBuddyModelPicker } from './WorkBuddyModelPicker.js'

function signInMessage(raw: string, en: boolean): string {
  switch (raw.replace(/^WorkBuddy · /, '')) {
    case 'desktop_browser_unavailable':
      return en
        ? 'Update Android System WebView, then open desktop sign-in again.'
        : '请先更新 Android System WebView，再打开电脑版登录。'
    case 'login_expired':
      return en
        ? 'This sign-in has expired. Start desktop sign-in again.'
        : '本次授权已过期，请重新点「电脑版登录」。'
    case 'connection_or_storage':
    case 'timeout':
      return en
        ? 'Could not complete this request. Check your connection and try again.'
        : '请求未完成，请检查网络后重试。'
    case 'personal_account_required':
      return en
        ? 'Choose your personal WorkBuddy account to continue.'
        : '请选择 WorkBuddy 个人账号完成授权。'
    default:
      return raw
  }
}

export function WorkBuddyChannel() {
  const en = useSettings((s) => resolveLocale(s.locale) !== 'zh-CN')
  const active = useSettings((s) => s.chatSource === 'workbuddy')
  const { metadata, name, pending } = useWorkBuddyState()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false),
    running = useRef(false)
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
  return (
    <section className="wb-group" aria-labelledby="wb-channel-heading">
      <h3 id="wb-channel-heading" className="wb-group-title">
        {en ? 'WorkBuddy sign-in' : 'WorkBuddy 登录'}
      </h3>
      <div className="wb-card">
        <div className="wb-row">
          <span className="wb-label">
            {en ? 'Personal account' : '个人账号'}
            <small className="wb-caption">
              {metadata
                ? name || (en ? 'Signed in' : '已登录')
                : pending
                  ? en
                    ? 'Waiting for Tencent approval'
                    : '等待腾讯授权'
                  : en
                    ? 'Signed out'
                    : '未登录'}
            </small>
          </span>
          <Button
            variant="outlined"
            size="s"
            disabled={busy || !hasWorkBuddyBridge}
            onClick={() =>
              void run(
                metadata ? disconnectWorkBuddy : pending ? cancelWorkBuddySignIn : signInWorkBuddy
              )
            }
          >
            {metadata
              ? en
                ? 'Sign out'
                : '退出登录'
              : pending
                ? en
                  ? 'Cancel'
                  : '取消'
                : en
                  ? 'Desktop sign-in'
                  : '电脑版登录'}
          </Button>
        </div>
        {metadata && (
          <>
            <div className="wb-row wb-model-field">
              <span className="wb-label">{en ? 'Default model' : '默认模型'}</span>
              <WorkBuddyModelPicker
                disabled={busy}
                en={en}
                label={en ? 'WorkBuddy model' : 'WorkBuddy 模型'}
                value={metadata.model}
                onChange={(model) => void run(() => selectWorkBuddyModel(model))}
              />
            </div>
            <label className="wb-row">
              <span className="wb-label">{en ? 'Use for new chats' : '用作默认对话通道'}</span>
              <input
                className="dc-local-switch"
                type="checkbox"
                role="switch"
                checked={active}
                disabled={busy}
                onChange={(e) => activateWorkBuddy(e.currentTarget.checked)}
              />
            </label>
          </>
        )}
      </div>
      {error && (
        <p className="wb-status" role="alert">
          {signInMessage(error, en)}
        </p>
      )}
      {!hasWorkBuddyBridge ? (
        <p className="wb-status">
          {en ? 'Sign in from the Android app.' : '请在 Android 应用内授权登录。'}
        </p>
      ) : pending ? (
        <p className="wb-status">
          {en
            ? 'Return here after approving access on Tencent’s page.'
            : '在腾讯页面完成授权后，返回此处即可。'}
        </p>
      ) : !metadata ? (
        <p className="wb-status">
          {en
            ? 'Use your phone number on the WorkBuddy desktop page, or scan its QR code with another device.'
            : '在 WorkBuddy 电脑版页面可选择手机号登录，也可用另一台设备扫码。'}
        </p>
      ) : null}
    </section>
  )
}
