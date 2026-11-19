import { useId, useState } from 'react'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  addMemory,
  editMemory,
  MEMORY_LIMIT,
  type Memory,
  type MemoryScope,
} from '../../services/library/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './MemorySettings.module.css'

export function MemoryEditor({
  memory,
  message,
  scope,
  onClose,
}: {
  scope: MemoryScope
  memory?: Memory
  message?: string
  onClose: () => void
}) {
  const t = useTranslate()
  const mobile = useIsSettingsMobile()
  const field = useId()
  const [value, setValue] = useState(memory?.text ?? message ?? '')
  const [failed, setFailed] = useState(false)
  const text = value.trim()
  const tooLong = text.length > MEMORY_LIMIT
  const folderOwned = memory ? memory.folderId !== null : scope.kind === 'folder'
  const chatOwned = memory ? memory.sessionId !== null : scope.kind === 'chat'
  const chatNotes = scope.kind === 'chat'
  const editorTitle = message !== undefined ? 'libMemoryFromMessage'
    : memory ? (chatNotes ? 'libNoteEdit' : 'libMemoryEdit')
    : chatNotes ? 'libNoteAdd' : 'libMemoryAdd'
  const save = () => {
    try {
      if (memory) {
        editMemory(memory.id, text, scope)
      } else {
        addMemory(
          text,
          scope.kind === 'chat' ? scope.id : null,
          scope.kind === 'folder' ? scope.id : null
        )
      }
      showToast({ key: chatNotes && message === undefined ? 'libNoteSaved' : 'libMemorySaved' })
      onClose()
    } catch {
      setFailed(true)
    }
  }
  return (
    <Modal
      placement={mobile ? 'bottom' : 'center'}
      closable
      onClose={onClose}
      title={t(editorTitle)}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={!text || tooLong} onClick={save}>
            {t(message === undefined ? 'libSave' : 'libMemorySave')}
          </Button>
        </>
      }
    >
      <label className={styles.fieldLabel} htmlFor={field}>
        {t(chatNotes ? 'libNoteText' : 'libMemoryText')}
      </label>
      <textarea
        id={field}
        className={styles.field}
        rows={4}
        value={value}
        placeholder={t('libMemoryPlaceholder')}
        aria-describedby={`${field}-limit`}
        aria-invalid={tooLong || undefined}
        onChange={(event) => {
          setValue(event.target.value)
          setFailed(false)
        }}
      />
      <div className={styles.fieldMeta} id={`${field}-limit`}>
        <span>
          {t(
            tooLong
              ? 'libMemoryShorten'
              : folderOwned
                ? 'libSaveToFolder'
                : chatOwned
                  ? (chatNotes ? 'libSaveToChatNotes' : 'memorySaveToChat')
                  : 'memorySaveGeneral'
          )}
        </span>
        <span className={styles.count}>
          {t('libLimit', { count: text.length, max: MEMORY_LIMIT })}
        </span>
      </div>
      {failed && (
        <p className={styles.error} role="alert">
          {t('libSaveError')}
        </p>
      )}
    </Modal>
  )
}
