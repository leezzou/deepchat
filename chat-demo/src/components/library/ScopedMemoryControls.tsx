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

export function ConversationMemoryControls({ sessionId }: { sessionId: string | null }) {
  const t = useTranslate()
  const { sessions, folders } = useLibrarySnapshot()
  const session = sessions.find((row) => row.sessionId === sessionId)
  const shared = folders.find((folder) => folder.id === session?.folderId && folder.shareMemory)
  return (
    <div className="lib-chat-memory-controls">
      <MemorySwitch
        label="libUseGlobalMemory"
        checked={getMemoryEnabled(sessionId)}
        change={(enabled) => setMemoryEnabled(sessionId, enabled)}
      />
      {sessionId && (
        <MemoryPanel label={t('libChatNotes')}>
          {shared ? (
            <p className="lib-note">{t('memoryFolderScope', { name: shared.name })}</p>
          ) : (
            <MemorySwitch
              label="libUseChatNotes"
              checked={session?.chatMemoryEnabled ?? false}
              change={(enabled) => setChatMemoryEnabled(sessionId, enabled)}
            />
          )}
          <MemoryList scope={{ kind: 'chat', id: sessionId }} />
        </MemoryPanel>
      )}
    </div>
  )
}
