import {
  IconMenuDouble24,
  IconNewChatOutline20,
  IconSpeakerWaves24,
  IconSpeakerWavesOff24,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat, useChatStore } from '../../services/chat/store.js'
import { setAutoRead, useSettings } from '../../services/settings.js'
import { useUpdateNotice } from '../../services/updateWatcher.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider, rememberChat, useMobileSider } from '../sider/mobileSiderState.js'
import { closeTopLayer } from '../../shell/backLayers.js'
import { ConversationControls } from './ConversationControls.js'
import styles from './MobileHeader.module.css'

export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const activeId = useChatStore((state) => state.activeId)
  const autoRead = useSettings((state) => state.autoRead)
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
      <div className={styles.title} data-home={!activeId || undefined}>
        <ConversationControls key={activeId} sessionId={activeId} heading={title || t('newChat')} />
        {!activeId && (
          <svg className={styles.modeIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M3 7h7m4 0h7M3 17h11m4 0h3" />
            <circle cx="12" cy="7" r="2.1" /><circle cx="16" cy="17" r="2.1" />
          </svg>
        )}
      </div>
      <div className={styles.right}>
        <IconButton
          size="xl"
          tone="primary"
          icon={autoRead ? <IconSpeakerWaves24 /> : <IconSpeakerWavesOff24 />}
          aria-label={t('autoReadAloud')}
          aria-pressed={autoRead}
          onClick={() => setAutoRead(!autoRead)}
        />
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
