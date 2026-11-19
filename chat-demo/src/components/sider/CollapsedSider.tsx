import { IconPanelLeftOutline16, IconSearchOutline16, NewChatIcon } from '../base/icons.js'
import { openHistorySearch } from '../historySearch/historySearchState.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { useUpdateNotice } from '../../services/updateWatcher.js'
import { IconButton } from '../base/IconButton.js'
import styles from './Sider.module.css'

/** 收起后左上角的按钮组 */
export const CollapsedSider = () => {
  const t = useTranslate()
  const hasUpdate = useUpdateNotice((state) => state.available !== null)
  return (
    <div className={styles.collapsed}>
      <div className={styles.collapsedGroup}>
        <span className={styles.collapsedItem}>
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPanelLeftOutline16 />}
            tooltip={
              hasUpdate
                ? `${t('expandSiderbarButton')}（${t('updateBadge')}）`
                : t('expandSiderbarButton')
            }
            onClick={() => setSiderCollapsed(false)}
          />
          {hasUpdate ? <span className={styles.updateDot} aria-hidden="true" /> : null}
        </span>
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={() => newChat()}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<IconSearchOutline16 />}
          tooltip={t('historySearch')}
          onClick={openHistorySearch}
        />
      </div>
    </div>
  )
}
