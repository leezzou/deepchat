import { Button } from '../components/base/Button.js'
import { closeSettings } from '../components/settings/settingsDialogState.js'
import { useTranslate } from '../i18n/index.js'
import { isDownloadedUpdateReady } from '../shell/installer.js'
import { useDrafts } from '../services/chat/drafts.js'
import { newChat, selectSession } from '../services/chat/store.js'
import {
  continueUpdateInstall,
  dismissPendingUpdate,
  useUpdateBlockReason,
  installReadyUpdate,
  requestSafeReload,
  useUpdateSafety,
} from '../services/updateSafety.js'
import styles from './App.module.css'

export const UpdateSafetyNotice = () => {
  const t = useTranslate()
  const { status, error, reloadPending, working } = useUpdateSafety()
  const reason = useUpdateBlockReason()
  const draftSessionId = useDrafts(
    (state) => [...state.drafts].find(([, draft]) => draft.text || draft.attachments.length)?.[0]
  )
  if (status === 'idle' && !reloadPending) {
    return null
  }
  const busy = status === 'downloading' || status === 'installing'
  const install = status === 'ready' || (status === 'permission' && isDownloadedUpdateReady())
  const messages = {
    idle: 'updateCanContinue',
    waiting: 'updateCanContinue',
    ready: 'updateReadySafe',
    permission: 'updatePermission',
    downloading: 'updateAwaitDownload',
    installing: 'updateInstalling',
    failed: 'updateDownloadFailed',
  } as const
  const message = reloadPending
    ? t('updateReloadPending')
    : error
      ? t(error)
      : !busy && reason
        ? t('updateWaiting', { reason: t(reason) })
        : t(messages[status])
  const showDraft = () => {
    const entry = [...useDrafts.getState().drafts].find(
      ([, draft]) => draft.text || draft.attachments.length
    )
    if (!entry) {
      return
    }
    closeSettings()
    if (entry[0] === null) {
      newChat()
    } else {
      selectSession(entry[0])
    }
  }
  return (
    <div className={styles.saveError} role="status" aria-live="polite">
      <span>{message}</span>
      {reason === 'updateWaitDrafts' && draftSessionId !== undefined ? (
        <Button variant="outlined" size="s" onClick={showDraft}>
          {t('updateShowDraft')}
        </Button>
      ) : null}
      {!busy ? (
        <Button
          variant="outlined"
          size="s"
          disabled={working || reason !== null}
          onClick={() => {
            void (reloadPending
              ? requestSafeReload()
              : install
                ? installReadyUpdate()
                : continueUpdateInstall())
          }}
        >
          {t(reloadPending ? 'updateReload' : install ? 'updateInstall' : 'updateContinue')}
        </Button>
      ) : null}
      {!busy ? (
        <Button variant="outlined" size="s" disabled={working} onClick={dismissPendingUpdate}>
          {t('updateCancelWaiting')}
        </Button>
      ) : null}
    </div>
  )
}
