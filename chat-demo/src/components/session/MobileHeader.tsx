import {
  IconMenuDouble24,
  IconNewChatOutline20,
  IconSpeakerWaves24,
  IconSpeakerWavesOff24,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { setAutoRead, useSettings } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏（官方 56dp，无标题无分隔线）：
 * 左「双横线」开抽屉；右「自动朗读」开关 + 「开启新对话」；会话页在菜单图标右侧显示标题。
 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const autoRead = useSettings((state) => state.autoRead)
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuDouble24 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
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
          onClick={newChat}
        />
      </div>
    </div>
  )
}
