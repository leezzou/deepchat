import { useIsMobile } from '../../app/viewport.js'
import { LibraryIcon } from './LibraryIcon.js'
import { Menu } from '../base/Menu.js'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createFolder,
  deleteFolder,
  renameFolder,
  type Folder,
} from '../../services/library/index.js'
import { useLibrarySnapshot } from '../../services/library/useLibrary.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import './library.css'

export type FolderFilter = string | null | undefined // undefined = all chats, null = unfiled

type Editor = { kind: 'name'; id?: string; name: string } | { kind: 'delete'; folder: Folder }
export const FolderPicker = ({
  current,
  onPick,
  onClose,
  moveSessionId,
}: {
  current: FolderFilter
  onPick: (filter: FolderFilter) => void
  onClose: () => void
  moveSessionId?: string
}) => {
  const t = useTranslate()
  const placement = useIsMobile() ? 'bottom' : 'center'
  const { folders } = useLibrarySnapshot()
  const [editor, setEditor] = useState<Editor | null>(null)
  const choose = (value: FolderFilter) => {
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
      if (editor.kind === 'delete') {
        deleteFolder(editor.folder.id)
      } else if (editor.id) {
        renameFolder(editor.id, editor.name)
      } else {
        const folderId = createFolder(editor.name, moveSessionId)
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
  const option = (value: FolderFilter, name: string) => (
    <button
      type="button"
      className="lib-option"
      aria-pressed={current === value}
      onClick={() => choose(value)}
    >
      <LibraryIcon name={value === undefined ? 'chats' : 'folder'} />
      <span>{name}</span>
      {current === value && <IconCheckOutline16 />}
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
          <Button block variant="outlined" onClick={() => setEditor({ kind: 'name', name: '' })}>
            {t(moveSessionId ? 'libCreateMove' : 'libNewFolder')}
          </Button>
        }
      >
        <ul className="lib-rows lib-folder-options">
          {!moveSessionId && <li className="lib-row">{option(undefined, t('libAll'))}</li>}
          <li className="lib-row">{option(null, t('libUngrouped'))}</li>
          {folders.map((folder) => (
            <li className="lib-row" key={folder.id}>
              {option(folder.id, folder.name)}
              {!moveSessionId && (
                <Menu
                  options={[
                    {
                      key: 'rename',
                      label: t('libRenameFolder'),
                      icon: <IconEditOutline16 />,
                      onSelect: () => setEditor({ kind: 'name', id: folder.id, name: folder.name }),
                    },
                    {
                      key: 'delete',
                      label: t('libDeleteFolder'),
                      icon: <IconTrashOutline16 />,
                      danger: true,
                      onSelect: () => setEditor({ kind: 'delete', folder }),
                    },
                  ]}
                >
                  {({ open, toggle }) => (
                    <IconButton
                      icon={<IconEllipsisOutline16 />}
                      aria-label={`${t('libManageFolders')} · ${folder.name}`}
                      aria-expanded={open}
                      aria-haspopup="menu"
                      onClick={toggle}
                    />
                  )}
                </Menu>
              )}
            </li>
          ))}
        </ul>
      </Modal>
      <ModalPresence>
        {editor && (
          <Modal
            placement={placement}
            title={t(
              editor.kind === 'delete'
                ? 'libDeleteFolder'
                : editor.id
                  ? 'libRenameFolder'
                  : 'libNewFolder'
            )}
            onClose={() => setEditor(null)}
            footer={
              <>
                <Button variant="outlined" onClick={() => setEditor(null)}>
                  {t('cancel')}
                </Button>
                <Button
                  disabled={editor.kind === 'name' && !editor.name.trim()}
                  variant={editor.kind === 'delete' ? 'danger' : 'primary'}
                  onClick={finish}
                >
                  {t(editor.kind === 'delete' ? 'delete' : 'libSave')}
                </Button>
              </>
            }
          >
            {editor.kind === 'delete' ? (
              t('libFolderDeleteHint', { name: editor.folder.name })
            ) : (
              <input
                className="lib-input"
                maxLength={80}
                aria-label={t('libFolderName')}
                placeholder={t('libFolderName')}
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
            )}
          </Modal>
        )}
      </ModalPresence>
    </>
  )
}
