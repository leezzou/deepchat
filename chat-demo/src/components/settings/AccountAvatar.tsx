import { useState } from 'react'
import { SettingsIcon } from './SettingsIcon.js'
import styles from './AccountSettings.module.css'

/** An account image is decorative beside its name. Keep a provider glyph if it fails to load. */
export function AccountAvatar({
  avatar,
  source,
  large = false,
}: {
  avatar?: string | null
  source: 'dsh' | 'workbuddy'
  large?: boolean
}) {
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <span className={styles.avatar} data-large={large || undefined} aria-hidden="true">
      {avatar && avatar !== failed ? (
        <img src={avatar} alt="" referrerPolicy="no-referrer" onError={() => setFailed(avatar)} />
      ) : (
        <SettingsIcon name={source === 'dsh' ? 'account' : 'work'} />
      )}
    </span>
  )
}
