import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { WhaleLogo } from '../base/WhaleLogo.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端 logo + 问候居中偏上、输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        {isMobile ? (
          <div className={styles.hero}>
            <WhaleLogo className={styles.logo} />
            <div className={styles.greeting}>{t('welcomeGreeting')}</div>
          </div>
        ) : (
          <div className={styles.greeting}>{t('welcomeGreeting')}</div>
        )}
        <ChatInput sessionId={null} />
      </div>
    </div>
  )
}
