import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconEllipsisOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed, useSettings } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { useUpdateNotice } from '../../services/updateWatcher.js'
import { SessionItem } from './SessionItem.js'
import { openHistorySearch } from '../historySearch/historySearchState.js'
import styles from './Sider.module.css'

/** 没有账号头像时的中性线稿头像 */
const AvatarGlyph = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="8.4" r="3.6" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M4.9 19.6c.9-3.2 3.7-5.2 7.1-5.2s6.2 2 7.1 5.2"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
)

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const accountSignedIn = useSettings((state) => state.accountSignedIn)
  const accountName = useSettings((state) => state.accountName)
  const accountAvatar = useSettings((state) => state.accountAvatar)
  const localName = useSettings((state) => state.displayName)
  const localAvatar = useSettings((state) => state.avatar)
  const userName = accountSignedIn && accountName ? accountName : localName
  const avatar = accountSignedIn ? accountAvatar : localAvatar
  const hasUpdate = useUpdateNotice((state) => state.available !== null)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      {mobile ? (
        <div className={styles.searchWrap}>
          <button
            type="button"
            className={styles.searchPill}
            onClick={openHistorySearch}
            aria-label={t('historySearch')}
          >
            <span className={styles.searchIcon}>
              <IconSearchOutline16 />
            </span>
            <span className={styles.searchInput}>{t('historySearchPlaceholder')}</span>
          </button>
        </div>
      ) : (
        <>
          <div className={styles.top}>
            <div className={styles.appName}>{t('appName')}</div>
            <IconButton
              size="m"
              icon={<IconPanelLeftOutline16 />}
              tooltip={t('collapseSiderbarButton')}
              tooltipPlacement="bottom"
              onClick={() => setSiderCollapsed(true)}
            />
          </div>
          <button
            type="button"
            className={styles.newChat}
            onClick={() => {
              newChat()
              closeMobileSider()
            }}
          >
            <span className={styles.newChatIcon}>
              <NewChatIcon />
            </span>
            {t('newChat')}
          </button>
          <button type="button" className={styles.searchButton} onClick={openHistorySearch}>
            <IconSearchOutline16 />
            <span>{t('historySearch')}</span>
          </button>
        </>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {mobile ? (
        <div className={styles.footer}>
          <div className={styles.avatar}>
            {avatar ? <img className={styles.avatarImage} src={avatar} alt="" /> : <AvatarGlyph />}
          </div>
          <div className={styles.userName}>{userName}</div>
          <span className={styles.footerMoreWrap}>
            <IconButton
              className={styles.footerMore}
              icon={<IconEllipsisOutline16 />}
              aria-label={t('settings')}
              onClick={() => openSettings('general')}
            />
            {hasUpdate ? <span className={styles.updateDot} /> : null}
          </span>
        </div>
      ) : (
        <div className={styles.bottom}>
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
              {hasUpdate ? <span className={styles.updateDot} aria-hidden="true" /> : null}
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        </div>
      )}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域或按 Esc 关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMobileSider()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])
  return (
    <>
      <div
        className={clsx(styles.drawerMask, open && styles.drawerMaskOpen)}
        onClick={closeMobileSider}
        aria-hidden
      />
      <div className={clsx(styles.drawer, open && styles.drawerOpen)} aria-hidden={!open}>
        <Sider mobile />
      </div>
    </>
  )
}
