import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

export const MobileSettingsHeader = ({ title, onBack }: { title: string; onBack: () => void }) => {
  const t = useTranslate()
  return (
    <header className={styles.topBar}>
      <button
        type="button"
        className={styles.backButton}
        aria-label={t('settingsBack')}
        onClick={onBack}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M14.5 5.5 8 12l6.5 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <h1 className={styles.pageTitle}>{title}</h1>
    </header>
  )
}
