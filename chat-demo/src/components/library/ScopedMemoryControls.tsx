import { useState, type ReactNode } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  getMemoryEnabled,
  setChatMemoryEnabled,
  setFolderSharing,
  setMemoryEnabled,
  type Folder,
} from '../../services/library/index.js'
import { useLibrarySnapshot } from '../../services/library/useLibrary.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { LibraryIcon } from './LibraryIcon.js'
import { MemoryList } from './MemorySettings.js'
import './library.css'
import './localSwitch.css'

function MemorySwitch({
  label,
  checked,
  change,
}: {
  label: TranslationKey
  checked: boolean
  change: (checked: boolean) => void
}) {
  const t = useTranslate()
  return (
    <label className="lib-memory-switch">
      <span>{t(label)}</span>
      <input
        type="checkbox"
        role="switch"
        className="dc-local-switch"
        checked={checked}
        onChange={(event) => {
          try {
            change(event.currentTarget.checked)
          } catch {
            showToast({ key: 'libSaveError', type: 'error' })
          }
        }}
      />
    </label>
  )
}

function MemoryPanel({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const mobile = useIsMobile()
  return (
    <>
      <button
        type="button"
        className="lib-memory-panel-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <LibraryIcon name="memory" />
        {label}
      </button>
      <ModalPresence>
        {open && (
          <Modal
            title={title ?? label}
            placement={mobile ? 'bottom' : 'center'}
            closable
            onClose={() => setOpen(false)}
          >
            {children}
          </Modal>
        )}
      </ModalPresence>
    </>
  )
}

export function FolderMemoryButton({ folder }: { folder: Folder }) {
  const t = useTranslate()
  return (
    <div className="lib-folder-memory-action">
      <MemoryPanel label={t('libFolderMemory')} title={`${folder.name} · ${t('libFolderMemory')}`}>
        <MemorySwitch
          label="libFolderShareMemory"
          checked={folder.shareMemory}
          change={(enabled) => setFolderSharing(folder.id, enabled)}
        />
        <p className="lib-note">{t('libFolderShareScope')}</p>
        <MemoryList scope={{ kind: 'folder', id: folder.id }} />
      </MemoryPanel>
    </div>
  )
}

export function GlobalMemorySwitch({ sessionId }: { sessionId: string | null }) {
  const t = useTranslate()
  useLibrarySnapshot()
  return (
    <label className="lib-header-memory">
      <input
        type="checkbox"
        role="switch"
        checked={getMemoryEnabled(sessionId)}
        onChange={(event) => {
          try {
            setMemoryEnabled(sessionId, event.currentTarget.checked)
          } catch {
            showToast({ key: 'libSaveError', type: 'error' })
          }
        }}
      />
      <span>{t('libUseGlobalMemory')}</span>
    </label>
  )
}

export function ChatNotesDialog({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string
  title: string
  onClose: () => void
}) {
  const t = useTranslate()
  const mobile = useIsMobile()
  const { sessions, folders } = useLibrarySnapshot()
  const session = sessions.find((row) => row.sessionId === sessionId)
  const shared = folders.find((folder) => folder.id === session?.folderId && folder.shareMemory)
  return (
    <Modal title={t('libChatNotes')} placement={mobile ? 'bottom' : 'center'} closable onClose={onClose}>
      <p className="lib-chat-note-origin" dir="auto">{title}</p>
      <p className="lib-note">{t(shared ? 'libChatNotesShared' : 'libChatNotesScope', { name: shared?.name ?? '' })}</p>
      {!shared && (
        <MemorySwitch
          label="libUseChatNotes"
          checked={session?.chatMemoryEnabled ?? false}
          change={(enabled) => setChatMemoryEnabled(sessionId, enabled)}
        />
      )}
      <MemoryList scope={{ kind: 'chat', id: sessionId }} />
    </Modal>
  )
}
