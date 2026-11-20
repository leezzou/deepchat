import { GlobalMemorySwitch } from '../library/ScopedMemoryControls.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { WhaleLogo } from '../base/WhaleLogo.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { AutoReadButton } from './AutoReadButton.js'
import { MobileHeader } from './MobileHeader.js'
import { ConversationControls } from './ConversationControls.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端 logo + 问候居中偏上、输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const returning = useChatStore((s) => s.sessions.length > 0)
  const en = useSettings((s) => resolveLocale(s.locale) === 'en-US')
  const greeting = returning
    ? t('welcomeGreeting')
    : en
      ? 'How can I help you today?'
      : '今天有什么可以帮到你？'
  return (
    <div className={styles.container}>
      {isMobile ? (
        <MobileHeader />
      ) : (
        <header className={styles.header}>
          <ConversationControls sessionId={null} />
          <GlobalMemorySwitch sessionId={null} />
          <AutoReadButton sessionId={null} />
        </header>
      )}
      <div className={styles.welcome}>
        {isMobile ? (
          <div className={styles.hero}>
            <WhaleLogo className={styles.logo} />
            <h1 className={styles.greeting}>{greeting}</h1>
          </div>
        ) : (
          <h1 className={styles.greeting}>{greeting}</h1>
        )}
        <ChatInput sessionId={null} />
      </div>
    </div>
  )
}
