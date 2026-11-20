import { IconMenuDouble24, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat, useChatStore } from '../../services/chat/store.js'
import { AutoReadButton } from './AutoReadButton.js'
import { useUpdateNotice } from '../../services/updateWatcher.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider, rememberChat, useMobileSider } from '../sider/mobileSiderState.js'
import { closeTopLayer } from '../../shell/backLayers.js'
import { GlobalMemorySwitch } from '../library/ScopedMemoryControls.js'
import { ConversationControls } from './ConversationControls.js'
import styles from './MobileHeader.module.css'

export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const activeId = useChatStore((state) => state.activeId)
  const hasUpdate = useUpdateNotice((state) => state.available !== null)
  const hasParent = useMobileSider((state) => state.parents.length > 0)
  return (
    <header className={styles.header}>
      <span className={styles.menuWrap}>
        {hasParent && <IconButton size="xl" tone="primary" aria-label={t('settingsBack')}
          onClick={closeTopLayer} icon={<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 12H4m7-7-7 7 7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>} />}
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconMenuDouble24 />}
          aria-label={
            hasUpdate
              ? `${t('expandSiderbarButton')}，${t('updateBadge')}`
              : t('expandSiderbarButton')
          }
          onClick={openMobileSider}
        />
        {hasUpdate ? <span className={styles.updateDot} aria-hidden="true" /> : null}
      </span>
      <div className={styles.title}>
        <ConversationControls key={activeId} sessionId={activeId} heading={title || t('libNewChat')} />
        <GlobalMemorySwitch sessionId={activeId} />
      </div>
      <div className={styles.right}>
        <AutoReadButton sessionId={activeId} mobile />
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t('newChat')}
          onClick={() => {
            const { activeId, importingHistory } = useChatStore.getState()
            if (importingHistory) {
              return
            }
            if (activeId) {
              rememberChat()
              newChat()
            } else {
              document.querySelector<HTMLTextAreaElement>('textarea[rows="2"]')?.focus({ preventScroll: true })
            }
          }}
        />
      </div>
    </header>
  )
}
