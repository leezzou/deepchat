import {
  setPinned,
  setMemoryEnabled,
  type SessionAttributes,
} from '../../services/library/index.js'
import { LibraryIcon } from '../library/LibraryIcon.js'
import { showToast } from '../base/toastState.js'
import { useBackLayer } from '../../shell/navigationMotion.js'
import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { visitChatFromDrawer } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  attributes,
  onMove,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  attributes?: SessionAttributes
  onMove: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  useBackLayer(editing, () => setEditing(false))
  const displayTitle = session.title || t('untitledChat')
  const modify = (action: () => void) => {
    try {
      action()
    } catch {
      showToast({ key: 'libSaveError', type: 'error' })
    }
  }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        aria-label={t('sessionItemMenuRenameOption')}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div className={clsx(styles.item, active && styles.active)}>
      <button
        type="button"
        className={styles.title}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          visitChatFromDrawer(session.id)
          selectSession(session.id)
        }}
      >
        {displayTitle}
      </button>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'pin',
              label: t(attributes?.pinned ? 'libUnpin' : 'libPin'),
              icon: <LibraryIcon name="pin" />,
              onSelect: () => modify(() => setPinned(session.id, !attributes?.pinned)),
            },
            {
              key: 'move',
              label: t('libMove'),
              icon: <LibraryIcon name="folder" />,
              onSelect: onMove,
            },
            {
              key: 'memory',
              label: t(attributes?.memoryEnabled ? 'libMemoryOff' : 'libMemoryOn'),
              icon: <LibraryIcon name="memory" />,
              onSelect: () =>
                modify(() => setMemoryEnabled(session.id, !attributes?.memoryEnabled)),
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})
