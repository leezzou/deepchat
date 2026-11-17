import { useSyncExternalStore } from 'react'
import { Button } from '../components/base/Button.js'
import { closeSettings } from '../components/settings/settingsDialogState.js'
import { useTranslate } from '../i18n/index.js'
import { useDrafts } from '../services/chat/drafts.js'
import { newChat, selectSession, useChatStore } from '../services/chat/store.js'
import {
  continueUpdateInstall,
  dismissPendingUpdate,
  getUpdateBlockReason,
  installReadyUpdate,
  requestSafeReload,
  useUpdateSafety,
} from '../services/updateSafety.js'
import { usePendingEdits } from '../services/pendingEdits.js'
import styles from './App.module.css'

const subscribeWork = (listener: () => void) => {
  const chat = useChatStore.subscribe(listener)
  const drafts = useDrafts.subscribe(listener)
  const edits = usePendingEdits.subscribe(listener)
  return () => {
    chat()
    drafts()
    edits()
  }
}

export const UpdateSafetyNotice = () => {
  const t = useTranslate()
  const { status, reloadPending, working } = useUpdateSafety()
  const reason = useSyncExternalStore(subscribeWork, getUpdateBlockReason)
  const draftSessionId = useDrafts(
    (state) => [...state.drafts].find(([, draft]) => draft.text || draft.attachments.length)?.[0]
  )
  if (status === 'idle' && !reloadPending) {
    return null
  }
  const message = reloadPending
    ? t('updateReloadPending')
    : status === 'downloading'
      ? t('updateAwaitDownload')
      : reason
        ? t('updateWaiting', { reason: t(reason) })
        : t(status === 'ready' ? 'updateReadySafe' : 'updateCanContinue')
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
      {status !== 'downloading' ? (
        <Button
          variant="outlined"
          size="s"
          disabled={working || reason !== null}
          onClick={() => {
            void (reloadPending
              ? requestSafeReload()
              : status === 'ready'
                ? installReadyUpdate()
                : continueUpdateInstall())
          }}
        >
          {t(
            reloadPending ? 'updateReload' : status === 'ready' ? 'updateInstall' : 'updateContinue'
          )}
        </Button>
      ) : null}
      {status !== 'downloading' ? (
        <Button variant="outlined" size="s" disabled={working} onClick={dismissPendingUpdate}>
          {t('updateCancelWaiting')}
        </Button>
      ) : null}
    </div>
  )
}
