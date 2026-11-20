import clsx from 'clsx'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  resolveLocale,
  useTranslate,
  type TranslationKey,
  type TranslationMessage,
} from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { listCompactions } from '../../services/chat/compactionIndex.js'
import { PostCommitRecoveryError } from '../../services/backup/portableMetadata.js'
import {
  BackupError,
  SnapshotError,
  confirmBackupSaved,
  exportHistory,
  loadBackupState,
  restoreSafetySnapshot,
  saveLatestBackup,
  saveSafetySnapshot,
  setAutomaticBackup,
  useBackupState,
} from '../../services/chat/backup.js'
import { Button } from '../base/Button.js'
import { ConfirmationModal, ModalPresence } from '../base/Modal.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { HistoryImportFeedback, type useHistoryImport } from './HistoryImportFeedback.js'
import { SettingsIcon, type SettingsIconName } from './SettingsIcon.js'
import styles from './Settings.module.css'
import './dataBackup.css'

const useLanguage = () => resolveLocale(useSettings((s) => s.locale))
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="history-group" aria-labelledby={id}>
      <h2 id={id} className={styles.groupTitle}>
        {title}
      </h2>
      <div className={styles.card}>{children}</div>
    </section>
  )
}
function Row({
  title,
  hint,
  icon,
  onClick,
  disabled,
  expanded,
  controls,
  danger,
}: {
  title: string
  hint?: string
  icon: SettingsIconName
  onClick?: () => void
  disabled?: boolean
  expanded?: boolean
  controls?: string
  danger?: boolean
}) {
  const id = useId()
  const body = (
    <>
      <span className={styles.rowIcon}>
        <SettingsIcon name={icon} />
      </span>
      <span className={styles.rowLabel}>
        <span id={id}>{title}</span>
        {hint && <small id={`${id}-hint`}>{hint}</small>}
      </span>
      {onClick && !danger && (
        <span
          className={clsx(styles.rowChevron, expanded && 'history-expanded')}
          aria-hidden="true"
        >
          <IconChevronRightOutline14 />
        </span>
      )}
    </>
  )
  return onClick ? (
    <button
      type="button"
      className={clsx(styles.row, 'history-row', danger && 'history-danger')}
      disabled={disabled}
      aria-labelledby={id}
      aria-describedby={hint ? `${id}-hint` : undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className={clsx(styles.row, 'history-row history-static')}>{body}</div>
  )
}

export interface MobileDataProps {
  historyImport: ReturnType<typeof useHistoryImport>
  onOpenWebDav: () => void
  onOpenCompacted: () => void
  onDeleteAll: () => void
}
function ImportRows({
  historyImport,
  disabled,
}: Pick<MobileDataProps, 'historyImport'> & { disabled: boolean }) {
  const t = useTranslate()
  const zh = useLanguage() === 'zh-CN'
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState('')
  const id = useId()
  const feedback = historyImport.feedback
  return (
    <>
      <Row
        icon="import"
        title={t('historyImport')}
        hint={
          zh
            ? '选择历史 ZIP，确认后替换本机对话。'
            : 'Choose a history ZIP to replace local chats after confirmation.'
        }
        disabled={disabled}
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        type="file"
        hidden
        accept=".zip,application/zip,application/x-zip-compressed"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            historyImport.select(file)
          }
        }}
      />
      {feedback?.source === 'file' && <HistoryImportFeedback feedback={feedback} />}
      <Row
        icon="platform"
        title={zh ? '从 DeepSeek 链接导入' : 'Import from a DeepSeek link'}
        onClick={() => setOpen(!open)}
        expanded={open}
        controls={id}
      />
      <div id={id} hidden={!open} className="history-details">
        <label className={styles.fieldLabel} htmlFor={`${id}-url`}>
          {t('deepseekImportLink')}
        </label>
        <input
          id={`${id}-url`}
          className={styles.fieldInput}
          disabled={disabled}
          value={link}
          placeholder={t('deepseekImportPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          onChange={(event) => setLink(event.target.value)}
        />
        <p>{t('deepseekImportHint')}</p>
        <Button
          variant="outlined"
          disabled={disabled || !link.trim()}
          onClick={async () => {
            if (await historyImport.download(link)) {
              setLink('')
            }
          }}
        >
          {t('deepseekImportAction')}
        </Button>
      </div>
      {feedback?.source === 'link' && <HistoryImportFeedback feedback={feedback} />}
    </>
  )
}

type Notice = TranslationMessage & { error?: boolean; reason?: TranslationKey }
const operations = {
  generating: 'backupGenerating',
  saving: 'backupSaving',
  snapshot: 'backupSnapshotting',
  restoring: 'backupRestoring',
} as const
const saved = {
  generated: 'backupGenerated',
  'download-requested': 'backupDownloadRequested',
  shared: 'backupShared',
  confirmed: 'backupConfirmed',
} as const
const reasons = {
  'before-import': 'backupBeforeImport',
  'before-clear': 'backupBeforeClear',
  'before-restore': 'backupBeforeRestore',
  manual: 'backupTitle',
  automatic: 'backupTitle',
} as const

export function DataSettings({
  disabled,
  mobile,
}: {
  disabled: boolean
  mobile?: MobileDataProps
}) {
  const t = useTranslate()
  const locale = useLanguage()
  const zh = locale === 'zh-CN'
  const backup = useBackupState()
  const empty = useChatStore((state) => !state.sessions.length)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [running, setRunning] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [autoPreview, setAutoPreview] = useState<boolean | null>(null)
  const guard = useRef(false)
  const id = useId()
  const busy = disabled || running || !!backup.operation
  const { latest, safety } = backup
  const date = (time: number) =>
    new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  useEffect(() => {
    void loadBackupState().catch(() => {})
  }, [])
  const run = async (action: () => Promise<unknown>, success?: TranslationKey) => {
    if (guard.current) {
      return
    }
    guard.current = true
    setRunning(true)
    setNotice(null)
    try {
      await action()
      if (success) {
        setNotice({ key: success })
      }
    } catch (error) {
      if (error instanceof PostCommitRecoveryError) {
        setNotice({ key: 'historyRecoveryPending', error: true })
      } else if (error instanceof SnapshotError) {
        setNotice({ key: 'backupSnapshotFailed', error: true })
      } else if (error instanceof BackupError) {
        setNotice({ key: 'backupActionFailed', reason: error.key, error: true })
      } else {
        setNotice({
          key: 'backupActionFailed',
          params: { message: error instanceof Error ? error.message : String(error) },
          error: true,
        })
      }
    } finally {
      guard.current = false
      setRunning(false)
    }
  }
  const message = notice
    ? t(notice.key, notice.reason ? { message: t(notice.reason) } : notice.params)
    : ''
  return (
    <div className="history-settings">
      <Group title={mobile ? (zh ? '导入与导出' : 'Import and export') : t('backupTitle')}>
        {mobile && <ImportRows historyImport={mobile.historyImport} disabled={busy} />}
        <Row
          icon="download"
          title={zh ? '导出历史备份' : 'Export history backup'}
          hint={
            latest
              ? t(saved[latest.saveStatus])
              : zh
                ? '生成 ZIP 文件，可保存到设备或分享。'
                : 'Create a ZIP to save or share.'
          }
          onClick={() => setExportOpen(!exportOpen)}
          expanded={exportOpen}
          controls={`${id}-export`}
        />
        <div id={`${id}-export`} className="history-details" hidden={!exportOpen}>
          <p>{t('backupContents')}</p>
          {latest && (
            <div className="history-file" role="status">
              <strong>{latest.name}</strong>
              {t('backupFileDetails', { date: date(latest.createdAt), count: latest.sessionCount })}
            </div>
          )}
          <div className="history-actions">
            <Button
              variant={latest ? 'outlined' : 'primary'}
              disabled={busy || empty}
              onClick={() => void run(exportHistory)}
            >
              {t(backup.operation === 'generating' ? 'backupGenerating' : 'backupGenerate')}
            </Button>
            {latest && (
              <Button disabled={busy} onClick={() => void run(saveLatestBackup)}>
                {t('backupSave')}
              </Button>
            )}
            {latest && ['shared', 'download-requested'].includes(latest.saveStatus) && (
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() => void run(() => confirmBackupSaved(latest.id))}
              >
                {t('backupConfirmSaved')}
              </Button>
            )}
          </div>
          <p>{t('backupLocalHint')}</p>
        </div>
      </Group>
      <Group title={zh ? '备份与恢复' : 'Backup and restore'}>
        <label className={clsx(styles.backupToggle, 'history-toggle')}>
          <span>
            {t('backupAutoLabel')}
            <small id={`${id}-auto`}>
              {zh
                ? '每完成 10 轮对话，生成本机副本并提醒另存。'
                : 'Every 10 completed rounds, create a local copy and remind me to save it.'}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={t('backupAutoLabel')}
            aria-describedby={`${id}-auto`}
            checked={autoPreview ?? backup.autoEnabled}
            disabled={busy || !backup.ready}
            onChange={(event) => {
              const enabled = event.target.checked
              setAutoPreview(enabled)
              void run(async () => {
                try {
                  await setAutomaticBackup(enabled)
                } finally {
                  setAutoPreview(null)
                }
              })
            }}
          />
        </label>
        {backup.autoEnabled && (
          <p className="history-progress">
            {t('backupAutoProgress', { count: Math.max(0, 10 - backup.completedRounds) })}
          </p>
        )}
        <Row
          icon="data"
          title={t('backupSafetyTitle')}
          hint={
            safety
              ? `${t(reasons[safety.reason])} · ${t('backupFileDetails', { date: date(safety.createdAt), count: safety.sessionCount })}`
              : t('backupSafetyEmpty')
          }
          onClick={safety ? () => setSnapshotOpen(!snapshotOpen) : undefined}
          expanded={safety ? snapshotOpen : undefined}
          controls={safety ? `${id}-snapshot` : undefined}
        />
        {safety && (
          <div hidden={!snapshotOpen} id={`${id}-snapshot`} className="history-details">
            <p>{t('backupSafetyHint')}</p>
            <div className="history-actions">
              <Button variant="outlined" disabled={busy} onClick={() => setRestoreOpen(true)}>
                {t('backupRestore')}
              </Button>
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await saveSafetySnapshot()
                    setNotice({ key: saved[result.status] })
                  })
                }
              >
                {t('backupDownloadSnapshot')}
              </Button>
            </div>
            <p>{t('backupSnapshotExportHint')}</p>
          </div>
        )}
        {mobile && (
          <Row
            icon="cloud"
            title={t('previewWebDav')}
            hint={
              zh
                ? '将加密备份保存到自己的服务器，或从中恢复。'
                : 'Save an encrypted copy on your server, or restore from it.'
            }
            disabled={busy}
            onClick={mobile.onOpenWebDav}
          />
        )}
      </Group>
      {backup.operation && (
        <p role="status" className="history-notice">
          {t(operations[backup.operation])}
        </p>
      )}
      {backup.error && (
        <div role="alert" className="history-notice history-error">
          <p>{t(backup.error === 'load' ? 'backupStorageFailed' : 'backupAutomaticFailed')}</p>
          {backup.error === 'load' && (
            <Button variant="outlined" disabled={busy} onClick={() => void run(loadBackupState)}>
              {t('backupRetry')}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={clsx('history-notice', notice.error && 'history-error')}
        >
          {message}
        </p>
      )}
      {mobile && (
        <Group title={zh ? '本机历史' : 'Local history'}>
          <Row
            icon="summaries"
            title={t('compactedEntry')}
            hint={
              zh
                ? `查看摘要或恢复完整上下文 · ${listCompactions().length} 个对话`
                : `View summaries or restore full context · ${listCompactions().length} chats`
            }
            onClick={mobile.onOpenCompacted}
          />
          <Row
            icon="delete"
            danger
            title={t('deleteAllHistory')}
            hint={
              zh
                ? '清空前会保存可恢复的本机安全快照。'
                : 'A local safety snapshot is saved before clearing.'
            }
            disabled={busy || empty}
            onClick={mobile.onDeleteAll}
          />
        </Group>
      )}
      <ModalPresence>
        {restoreOpen && safety && (
          <ConfirmationModal
            title={t('backupRestoreTitle')}
            onClose={() => {
              if (!running) {
                setRestoreOpen(false)
              }
            }}
            footer={
              <>
                <Button
                  variant="outlined"
                  autoFocus
                  disabled={running}
                  onClick={() => setRestoreOpen(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await restoreSafetySnapshot()
                      setRestoreOpen(false)
                    }, 'backupRestored')
                  }
                >
                  {t(running ? 'backupRestoring' : 'backupRestore')}
                </Button>
              </>
            }
          >
            <p>
              {t('backupRestoreDescription', {
                date: date(safety.createdAt),
                count: safety.sessionCount,
              })}
            </p>
            {notice?.error && (
              <p role="alert" className="history-error">
                {message}
              </p>
            )}
          </ConfirmationModal>
        )}
      </ModalPresence>
    </div>
  )
}
