import { useState } from 'react'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  deleteMemory,
  getManagedMemories,
  type MemoryScope,
  type Memory,
} from '../../services/library/index.js'
import { useLibrarySnapshot } from '../../services/library/useLibrary.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14, IconTrashOutline16 } from '../base/icons.js'
import { ConfirmationModal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { LibraryIcon } from './LibraryIcon.js'
import { MemoryEditor } from './MemoryEditor.js'
import styles from './MemorySettings.module.css'
import './localSwitch.css'

type Action = { kind: 'edit'; memory?: Memory } | { kind: 'delete'; memory: Memory }

export const MemorySettings = () => <MemoryList scope={{ kind: 'global' }} />

export function MemoryList({ scope }: { scope: MemoryScope }) {
  const t = useTranslate()
  const mobile = useIsSettingsMobile()
  useLibrarySnapshot()
  const chatNotes = scope.kind === 'chat'
  const memories = getManagedMemories(scope)
  const [action, setAction] = useState<Action | null>(null)
  const close = () => setAction(null)
  const save = (change: () => void) => {
    try {
      change()
      close()
    } catch {
      showToast({ key: 'libSaveError', type: 'error' })
    }
  }
  return (
    <div className={styles.page} data-mobile={(mobile && scope.kind === 'global') || undefined}>
      <section>
        <h3 className={styles.heading}>
          {t(chatNotes ? 'libNotesList' : scope.kind === 'global' ? 'libGlobalMemories' : 'libMemories')}
          {memories.length > 0 && <span className={styles.total}>{memories.length}</span>}
        </h3>
        <div className={styles.group}>
          {!memories.length && (
            <div className={styles.empty}>
              <LibraryIcon name="memory" />
              <strong>{t(chatNotes ? 'libNotesEmpty' : 'libMemoryEmptyTitle')}</strong>
              <p>
                {t(
                  scope.kind === 'folder'
                    ? 'libFolderMemoryEmpty'
                    : scope.kind === 'global'
                      ? 'libGlobalMemoryEmpty'
                      : 'libMemoryEmpty'
                )}
              </p>
            </div>
          )}
          {memories.length > 0 && (
            <ul className={styles.list}>
              {memories.map((memory) => (
                <li key={memory.id} className={styles.item}>
                  <button
                    className={styles.edit}
                    aria-label={`${t(chatNotes ? 'libNoteEdit' : 'libMemoryEdit')} · ${memory.text}`}
                    onClick={() => setAction({ kind: 'edit', memory })}
                  >
                    <span className={styles.memoryBody}>
                      <span className={styles.excerpt} dir="auto">
                        {memory.text}
                      </span>
                      {scope.kind === 'folder' && (
                        <small>{t(memory.folderId ? 'libFolderMemory' : 'memoryFromFolder')}</small>
                      )}
                    </span>
                    <IconChevronRightOutline14 />
                  </button>
                  <button
                    className={styles.remove}
                    aria-label={`${t(chatNotes ? 'libNoteDelete' : 'libMemoryDelete')} · ${memory.text}`}
                    onClick={() => setAction({ kind: 'delete', memory })}
                  >
                    <IconTrashOutline16 />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className={styles.add} onClick={() => setAction({ kind: 'edit' })}>
            <span className={styles.plus} aria-hidden="true" />
            {t(chatNotes ? 'libNoteAdd' : 'libMemoryAdd')}
          </button>
        </div>
        {scope.kind === 'global' && <p className={styles.scope}>{t('libGlobalScope')}</p>}
      </section>
      <ModalPresence>
        {action &&
          (action.kind === 'edit' ? (
            <MemoryEditor scope={scope} memory={action.memory} onClose={close} />
          ) : (
            <ConfirmationModal
              title={t(chatNotes ? 'libNoteDeleteConfirm' : 'libMemoryDeleteConfirm')}
              onClose={close}
              footer={
                <>
                  <Button variant="outlined" onClick={close}>
                    {t('cancel')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => save(() => deleteMemory(action.memory.id, scope))}
                  >
                    {t('delete')}
                  </Button>
                </>
              }
            >
              <p className={styles.deleteHint}>{t(chatNotes ? 'libNoteDeleteHint' : 'libMemoryDeleteHint')}</p>
              <blockquote className={styles.quote} dir="auto">
                {action.memory.text}
              </blockquote>
            </ConfirmationModal>
          ))}
      </ModalPresence>
    </div>
  )
}
