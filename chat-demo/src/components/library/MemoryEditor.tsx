import { useId, useState } from 'react'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { addMemory, editMemory, MEMORY_LIMIT, type Memory } from '../../services/library/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './MemorySettings.module.css'

export function MemoryEditor({
  memory,
  message,
  onClose,
}: {
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
  const save = () => {
    try {
      if (memory) {
        editMemory(memory.id, text)
      } else {
        addMemory(text)
      }
      showToast({ key: 'libMemorySaved' })
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
      title={t(
        memory ? 'libMemoryEdit' : message === undefined ? 'libMemoryAdd' : 'libMemoryFromMessage'
      )}
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
        {t('libMemoryText')}
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
        <span>{t(tooLong ? 'libMemoryShorten' : 'libMemorySavedLocally')}</span>
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
