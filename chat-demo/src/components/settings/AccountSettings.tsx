import { useId } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setIdentityPreference, useAccountIdentity } from '../../services/identity.js'
import { setChatSource, useSettings } from '../../services/settings.js'
import { hasWorkBuddyBridge, useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { hasAccountBridge, openAccount } from '../../shell/account.js'
import { IconCheckOutline16, IconChevronRightOutline14 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { AccountAvatar } from './AccountAvatar.js'
import styles from './AccountSettings.module.css'

export function AccountSettings({ onWorkBuddy }: { onWorkBuddy: () => void }) {
  const t = useTranslate()
  const identities = useAccountIdentity()
  const hasKey = useSettings((s) => !!s.apiKey)
  const signedIn = useSettings((s) => s.accountSignedIn)
  const source = useSettings((s) => s.chatSource)
  const wbRoute = useWorkBuddyState((s) => s.metadata)
  const radioName = useId()
  const options = [
    ...(hasAccountBridge ? [{ value: 'account' as const, label: t('dshAccountBalance') }] : []),
    { value: 'api' as const, label: 'API Key' },
    ...(wbRoute || source === 'workbuddy'
      ? [{ value: 'workbuddy' as const, label: 'WorkBuddy' }]
      : []),
  ]
  const canChooseSource = !!(
    wbRoute ||
    source === 'workbuddy' ||
    (source === 'account' ? hasKey : signedIn)
  )
  if (!hasAccountBridge && !hasWorkBuddyBridge) {
    return <p className={styles.empty}>{t('accountAppOnly')}</p>
  }
  return (
    <div className={styles.accounts}>
      {(['dsh', 'workbuddy'] as const).map((provider) => {
        const dsh = provider === 'dsh'
        if (!(dsh ? hasAccountBridge : hasWorkBuddyBridge)) {
          return null
        }
        const identity = identities[provider]
        const providerLabel = t(dsh ? 'dshAccount' : 'workBuddyAccount')
        return (
          <button
            type="button"
            key={provider}
            className={styles.accountRow}
            data-dsh-account={dsh || undefined}
            data-wb-account-entry={!dsh || undefined}
            onClick={dsh ? openAccount : onWorkBuddy}
          >
            <AccountAvatar key={identity?.revision} source={provider} avatar={identity?.avatar} />
            <span className={styles.accountText}>
              <span className={styles.accountName} dir="auto">
                {identity?.name || t(dsh ? 'dshAccountLogin' : 'workBuddyLogin')}
              </span>
              {identity && (
                <span className={styles.detail}>
                  {providerLabel} · {t(dsh ? 'dshAccountManage' : 'wbAccountDetails')}
                </span>
              )}
            </span>
            <IconChevronRightOutline14 />
          </button>
        )
      })}
      {identities.canChoose && (
        <fieldset className={styles.choice} data-identity-picker>
          <legend>{t('identityChoice')}</legend>
          <div className={styles.options}>
            {(['dsh', 'workbuddy'] as const).map((provider) => {
              const checked = identities.selected?.source === provider
              return (
                <label key={provider} className={styles.option} data-checked={checked || undefined}>
                  <input
                    type="radio"
                    name={radioName}
                    value={provider}
                    data-identity-choice={provider}
                    checked={checked}
                    onChange={() => setIdentityPreference(provider)}
                  />
                  <span className={styles.optionText}>
                    {provider === 'dsh' ? 'DeepSeek' : 'WorkBuddy'}
                  </span>
                  {checked && <IconCheckOutline16 />}
                </label>
              )
            })}
          </div>
        </fieldset>
      )}
      {canChooseSource && (
        <div className={styles.sourceRow}>
          <span>{t('dshChatUses')}</span>
          <Select
            ariaLabel={t('dshChatUses')}
            value={source}
            options={options}
            onChange={(value) => {
              setChatSource(value)
              if (value === 'account' && !signedIn) {
                openAccount()
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
