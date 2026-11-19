import { useId, useState } from 'react'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  deleteMemory,
  getMemoryEnabled,
  getSessionFolderId,
  getVisibleMemories,
  setMemoryEnabled,
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

export const MemorySettings = () => {
  const t = useTranslate()
  const mobile = useIsSettingsMobile()
  const { folders } = useLibrarySnapshot()
  const activeId = useChatStore((state) => state.activeId)
  const memories = getVisibleMemories(activeId)
  const folder = folders.find((item) => item.id === getSessionFolderId(activeId))
  const folderDraft = Boolean(folder && !activeId)
  const title = useChatStore(
    (state) => state.sessions.find((session) => session.id === activeId)?.title
  )
  const description = useId()
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
    <div className={styles.page} data-mobile={mobile || undefined}>
      <section>
        <h3 className={styles.heading}>{t('libMemoryChat')}</h3>
        <label className={styles.switchRow}>
          <span className={styles.chatText}>
            <span>{t(folder?.shareMemory ? 'memoryIncludeGlobal' : 'libMemoryUse')}</span>
            <small>{title || t(activeId ? 'untitledChat' : 'libNewChat')}</small>
          </span>
          <input
            className="dc-local-switch"
            type="checkbox"
            role="switch"
            aria-label={t(folder?.shareMemory ? 'memoryIncludeGlobal' : 'libMemoryUse')}
            aria-describedby={description}
            checked={getMemoryEnabled(activeId)}
            onChange={({ currentTarget }) =>
              save(() => setMemoryEnabled(activeId, currentTarget.checked))
            }
          />
        </label>
        <p id={description} className={styles.scope}>
          {folder?.shareMemory
            ? t('memoryFolderScope', { name: folder.name })
            : t('memoryPrivateScope')}
        </p>
      </section>
      <section>
        <h3 className={styles.heading}>
          {t('libMemories')}
          {memories.length > 0 && <span className={styles.total}>{memories.length}</span>}
        </h3>
        <div className={styles.group}>
          {!memories.length && (
            <div className={styles.empty}>
              <LibraryIcon name="memory" />
              <strong>{t('libMemoryEmptyTitle')}</strong>
              <p>{t('libMemoryEmpty')}</p>
            </div>
          )}
          {memories.length > 0 && (
            <ul className={styles.list}>
              {memories.map((memory) => (
                <li key={memory.id} className={styles.item}>
                  <button
                    className={styles.edit}
                    aria-label={`${t('libMemoryEdit')} · ${memory.text}`}
                    onClick={() => setAction({ kind: 'edit', memory })}
                  >
                    <span className={styles.memoryBody}>
                      <span className={styles.excerpt} dir="auto">
                        {memory.text}
                      </span>
                      <small>
                        {t(
                          memory.sessionId === null
                            ? 'memoryGlobal'
                            : memory.sessionId === activeId
                              ? 'memoryThisChat'
                              : 'memoryFromFolder'
                        )}
                      </small>
                    </span>
                    <IconChevronRightOutline14 />
                  </button>
                  <button
                    className={styles.remove}
                    aria-label={`${t('libMemoryDelete')} · ${memory.text}`}
                    onClick={() => setAction({ kind: 'delete', memory })}
                  >
                    <IconTrashOutline16 />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            className={styles.add}
            disabled={folderDraft}
            onClick={() => setAction({ kind: 'edit' })}
          >
            <span className={styles.plus} aria-hidden="true" />
            {t('libMemoryAdd')}
          </button>
        </div>
        {folderDraft && <p className={styles.scope}>{t('memoryFolderDraft')}</p>}
      </section>
      <ModalPresence>
        {action &&
          (action.kind === 'edit' ? (
            <MemoryEditor sessionId={activeId} memory={action.memory} onClose={close} />
          ) : (
            <ConfirmationModal
              title={t('libMemoryDeleteConfirm')}
              onClose={close}
              footer={
                <>
                  <Button variant="outlined" onClick={close}>
                    {t('cancel')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => save(() => deleteMemory(action.memory.id))}
                  >
                    {t('delete')}
                  </Button>
                </>
              }
            >
              <p className={styles.deleteHint}>{t('libMemoryDeleteHint')}</p>
              <blockquote className={styles.quote} dir="auto">
                {action.memory.text}
              </blockquote>
            </ConfirmationModal>
          ))}
      </ModalPresence>
    </div>
  )
}
