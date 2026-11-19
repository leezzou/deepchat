import { useEffect, useId, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  createFolder,
  deleteFolder,
  GUIDE_FOLDER_ID,
  updateFolder,
  type Folder,
} from '../../services/library/index.js'
import { useLibrarySnapshot } from '../../services/library/useLibrary.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconCheckOutline16, IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { LibraryIcon } from './LibraryIcon.js'
import './library.css'
import './localSwitch.css'

type Editor = { id?: string; name: string; shareMemory: boolean }

export const FolderPicker = ({
  current,
  onPick,
  onClose,
  moveSessionId,
}: {
  current: string | undefined
  onPick: (folderId: string | undefined) => void
  onClose: () => void
  moveSessionId?: string
}) => {
  const t = useTranslate()
  const placement = useIsMobile() ? 'bottom' : 'center'
  const { folders } = useLibrarySnapshot()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleting, setDeleting] = useState<Folder | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const returnToList = useRef(false)
  const nameId = useId()
  const scopeId = useId()
  const guide = folders.find((folder) => folder.id === GUIDE_FOLDER_ID)
  const [showGuide] = useState(() => {
    try {
      return localStorage.getItem('deepchat:folder-guide-seen') !== '1'
    } catch {
      return true
    }
  })
  useEffect(() => {
    if (guide && !moveSessionId && showGuide) {
      try {
        localStorage.setItem('deepchat:folder-guide-seen', '1')
      } catch {
        // The guide remains usable when browser storage is unavailable.
      }
    }
  }, [guide, moveSessionId, showGuide])
  const choose = (value: string | undefined) => {
    try {
      onPick(value)
      onClose()
    } catch {
      showToast({ key: 'libSaveError', type: 'error' })
    }
  }
  const finish = () => {
    if (!editor) {
      return
    }
    try {
      if (editor.id) {
        updateFolder(editor.id, editor.name, editor.shareMemory)
      } else {
        const folderId = createFolder(editor.name, moveSessionId, editor.shareMemory)
        if (!moveSessionId) {
          onPick(folderId)
        }
        onClose()
      }
      setEditor(null)
    } catch {
      showToast({ key: 'libSaveError', type: 'error' })
    }
  }
  const option = (folder?: Folder) => (
    <button
      type="button"
      className="lib-option"
      aria-pressed={current === folder?.id}
      onClick={() => choose(folder?.id)}
    >
      <LibraryIcon name={folder ? 'folder' : 'chats'} />
      <span>
        {folder?.name ?? t('libAll')}
        {folder?.shareMemory && <small className="lib-shared-status">{t('libSharingOn')}</small>}
      </span>
      {current === folder?.id && <IconCheckOutline16 />}
    </button>
  )
  return (
    <>
      <Modal
        placement={placement}
        title={t(moveSessionId ? 'libMove' : 'libFolders')}
        closable
        onClose={onClose}
        footer={
          <Button
            block
            variant="outlined"
            onClick={() => setEditor({ name: '', shareMemory: false })}
          >
            {t(moveSessionId ? 'libCreateMove' : 'libNewFolder')}
          </Button>
        }
      >
        <ul className="lib-rows lib-folder-options" ref={listRef}>
          {!moveSessionId && <li className="lib-row">{option()}</li>}
          {folders.map((folder) => (
            <li className="lib-row" key={folder.id}>
              {option(folder)}
              {!moveSessionId && (
                <IconButton
                  icon={<IconEditOutline16 />}
                  aria-label={`${t('libEditFolder')} · ${folder.name}`}
                  aria-haspopup="dialog"
                  onClick={() => setEditor({ ...folder })}
                />
              )}
            </li>
          ))}
        </ul>
        {moveSessionId && current && (
          <button className="lib-remove-folder" type="button" onClick={() => choose(undefined)}>
            {t('libRemoveFromFolder')}
          </button>
        )}
        {moveSessionId && !folders.length && <p className="lib-note">{t('libNoFolders')}</p>}
        {!moveSessionId && guide && showGuide && (
          <p className="lib-guide-note">{t('libGuideFolderNote', { name: guide.name })}</p>
        )}
      </Modal>
      <ModalPresence
        onExited={() => {
          if (returnToList.current) {
            returnToList.current = false
            listRef.current
              ?.querySelector<HTMLButtonElement>('.lib-option')
              ?.focus({ preventScroll: true })
          }
        }}
      >
        {editor && (
          <Modal
            placement={placement}
            title={t(editor.id ? 'libEditFolder' : 'libNewFolder')}
            onClose={() => setEditor(null)}
            footer={
              <>
                <Button variant="outlined" onClick={() => setEditor(null)}>
                  {t('cancel')}
                </Button>
                <Button disabled={!editor.name.trim()} variant="primary" onClick={finish}>
                  {t('libSave')}
                </Button>
              </>
            }
          >
            <div className="lib-folder-form">
              <label htmlFor={nameId}>{t('libFolderName')}</label>
              <input
                id={nameId}
                className="lib-input"
                maxLength={80}
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    editor.name.trim()
                  ) {
                    finish()
                  }
                }}
              />
              <label className="lib-switch-row">
                <span>{t('libFolderShareMemory')}</span>
                <input
                  className="dc-local-switch"
                  type="checkbox"
                  role="switch"
                  checked={editor.shareMemory}
                  aria-describedby={scopeId}
                  onChange={(event) => setEditor({ ...editor, shareMemory: event.target.checked })}
                />
              </label>
              <p className="lib-note" id={scopeId}>
                {t('libFolderShareScope')}
              </p>
              {editor.id && (
                <button
                  type="button"
                  className="lib-folder-delete"
                  onClick={() => setDeleting(folders.find((item) => item.id === editor.id) ?? null)}
                >
                  <IconTrashOutline16 />
                  {t('libDeleteFolder')}
                </button>
              )}
            </div>
          </Modal>
        )}
      </ModalPresence>
      <ModalPresence>
        {deleting && (
          <Modal
            placement={placement}
            title={t('libDeleteFolder')}
            onClose={() => setDeleting(null)}
            footer={
              <>
                <Button variant="outlined" onClick={() => setDeleting(null)}>
                  {t('cancel')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    try {
                      deleteFolder(deleting.id)
                      returnToList.current = true
                      setDeleting(null)
                      setEditor(null)
                    } catch {
                      showToast({ key: 'libSaveError', type: 'error' })
                    }
                  }}
                >
                  {t('delete')}
                </Button>
              </>
            }
          >
            {t('libFolderDeleteHint', { name: deleting.name })}
          </Modal>
        )}
      </ModalPresence>
    </>
  )
}
