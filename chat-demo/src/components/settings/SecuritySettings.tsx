import { useEffect, useState, useSyncExternalStore } from 'react'
import { resolveLocale } from '../../i18n/index.js'
import { initializeCredentials, useSettings } from '../../services/settings.js'
import {
  androidShell,
  configureLock,
  hasSecurityPort,
  refreshSecurity,
  securityState,
  subscribeSecurity,
} from '../../services/security/bridge.js'
import { SettingsIcon } from './SettingsIcon.js'
import '../library/localSwitch.css'
import './securitySettings.css'

export function SecuritySettings() {
  const zh = useSettings((state) => resolveLocale(state.locale)) === 'zh-CN'
  const t = (cn: string, en: string) => (zh ? cn : en)
  const status = useSettings((state) => state.credentialStatus)
  const profileCount = useSettings((state) => state.apiProfiles.length)
  const lock = useSyncExternalStore(subscribeSecurity, securityState)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    void refreshSecurity().catch(() => setFailure('unavailable'))
  }, [])

  const toggle = async () => {
    setBusy(true)
    setFailure('')
    try {
      await configureLock(!lock.enabled)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'unavailable')
    } finally {
      setBusy(false)
    }
  }

  const explanation = !androidShell
    ? t(
        '使用 Android 版 DeepChat 即可开启应用锁。',
        'App lock is available in DeepChat for Android.'
      )
    : !hasSecurityPort || !lock.vault
      ? t(
          '请更新 Android 系统和 Android System WebView 后重试。',
          'Update Android and Android System WebView to use this feature.'
        )
      : !lock.available
        ? t(
            '请先在系统设置中设置屏幕锁定 PIN、图案或密码。',
            'First set a screen lock PIN, pattern or password in system settings.'
          )
        : t(
            '每次打开、从后台返回或接收系统分享时，使用系统身份验证解锁。',
            'Verify your identity when opening DeepChat, returning to it or receiving a share.'
          )

  return (
    <div className="security-settings">
      <section aria-labelledby="security-lock-title">
        <label className="security-setting-row security-toggle">
          <SettingsIcon name="lock" />
          <span id="security-lock-title">{t('应用锁', 'App lock')}</span>
          <input type="checkbox" role="switch" className="dc-local-switch"
            aria-labelledby="security-lock-title" aria-describedby="security-lock-hint"
            checked={lock.enabled} disabled={!lock.available || busy} onChange={() => void toggle()} />
        </label>
        <p id="security-lock-hint">{explanation}</p>
        {busy && <p role="status">{t('等待系统验证…', 'Waiting for system verification…')}</p>}
        {!!failure && (
          <p role="alert">
            {failure === 'cancelled'
              ? t(
                  '未完成验证。应用锁设置保持原样。',
                  'Verification was cancelled. Your app lock setting is unchanged.'
                )
              : t(
                  '无法更改应用锁。请检查系统屏幕锁定设置后重试。',
                  'Check your device screen lock settings and try again.'
                )}
          </p>
        )}
      </section>
      <section aria-labelledby="security-keys-title">
        <div className="security-setting-row">
          <SettingsIcon name="key" />
          <h3 id="security-keys-title">{t('API 密钥存储', 'API key storage')}</h3>
          <span className="security-setting-value">
            {status === 'ready'
              ? t(
                  `${profileCount} 个配置`,
                  `${profileCount} ${profileCount === 1 ? 'profile' : 'profiles'}`
                )
              : status === 'loading'
                ? t('检查中', 'Checking')
                : t('等待重试', 'Needs attention')}
          </span>
        </div>
        <p>
          {status === 'unavailable'
            ? t(
                '无法确认安全存储中的配置。解锁设备、检查可用空间或更新系统后重试。',
                'Secure storage could not be verified. Unlock your device, check storage space or update your system, then retry.'
              )
            : androidShell
              ? t(
                  'API Key 由 Android Keystore 密钥加密保存在此设备上。账户登录凭据由系统单独保存。',
                  'API keys are encrypted on this device with Android Keystore. Account sign-in credentials are stored separately.'
                )
              : t(
                  'API Key 在当前浏览器中加密保存。清除站点数据也会移除密钥。',
                  'API keys are encrypted in this browser. Clearing site data also removes your keys.'
                )}
        </p>
        {status === 'unavailable' && (
          <button
            type="button"
            className="security-retry"
            onClick={() => void initializeCredentials().catch(() => {})}
          >
            {t('重新检查', 'Check again')}
          </button>
        )}
      </section>
    </div>
  )
}
