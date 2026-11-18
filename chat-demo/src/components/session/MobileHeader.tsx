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
import { openMobileSider, rememberChat } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏（官方 56dp，无标题无分隔线）：
 * 左「双横线」开抽屉；右「自动朗读」开关 + 「开启新对话」；会话页在菜单图标右侧显示标题。
 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const autoRead = useSettings((state) => state.autoRead)
  const hasUpdate = useUpdateNotice((state) => state.available !== null)
  return (
    <div className={styles.header}>
      <span className={styles.menuWrap}>
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconMenuDouble24 />}
          aria-label={hasUpdate ? `${t('expandSiderbarButton')}，${t('updateBadge')}` : t('expandSiderbarButton')}
          onClick={openMobileSider}
        />
        {hasUpdate ? <span className={styles.updateDot} aria-hidden="true" /> : null}
      </span>
      {title === undefined ? null : <div className={styles.title}>{title}</div>}
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
            if (activeId && !importingHistory) rememberChat(activeId)
            newChat()
          }}
        />
      </div>
    </div>
  )
}
