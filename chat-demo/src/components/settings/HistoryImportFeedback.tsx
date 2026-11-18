import { useRef, useState } from 'react'
import { resolveLocale, useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { BackupError, importHistory, type HistoryImportStage } from '../../services/chat/backup.js'
import { downloadArchive } from '../../services/chat/history/downloadArchive.js'
import { importFailure, importPercent, type ImportFeedback, type ImportSource, type ImportStage } from './importFeedback.js'
import styles from './Settings.module.css'

/** Keep the current attempt across breakpoint changes and settings navigation. */
export const useHistoryImport = () => {
  const [selection, setSelection] = useState<{ file: File; source: ImportSource } | null>(null)
  const [feedback, setFeedback] = useState<ImportFeedback | null>(null)
  const inFlight = useRef(false)

  const select = (file: File) => {
    if (inFlight.current) { return }
    setFeedback(null)
    setSelection({ file, source: 'file' })
  }

  const download = async (link: string) => {
    if (inFlight.current || selection) { return false }
    const url = link.trim()
    try {
      if (!['https:', 'http:'].includes(new URL(url).protocol)) { throw new Error() }
    } catch {
      setFeedback({ source: 'link', state: 'failed', stage: 'downloading',
        failure: { reason: 'importBadLink', action: 'importPasteLink' } })
      return false
    }
    inFlight.current = true
    const downloading = { source: 'link', state: 'running', stage: 'downloading' } as const
    setFeedback(downloading)
    try {
      const file = await downloadArchive(url, 'deepseek-export.zip', (processed, total) => {
        setFeedback({ ...downloading, bytes: { processed, total } })
      })
      setSelection({ file, source: 'link' })
      setFeedback(null)
      return true
    } catch (error) {
      setFeedback({ source: 'link', state: 'failed', ...importFailure('downloading', error) })
      return false
    } finally {
      inFlight.current = false
    }
  }

  const confirm = async () => {
    if (!selection || inFlight.current) { return }
    const { file, source } = selection
    let stage: HistoryImportStage = 'reading'
    inFlight.current = true
    setSelection(null)
    setFeedback({ state: 'running', stage, source })
    try {
      const count = await importHistory(file, (processed, total) => {
        setFeedback({ source, state: 'running', stage, bytes: { processed, total } })
      }, (next) => {
        stage = next
        setFeedback({ source, state: 'running', stage })
      })
      setFeedback({ source, state: 'success', count })
    } catch (error) {
      const archiveKey = error instanceof BackupError ? error.key : undefined
      setFeedback({ source, state: 'failed', ...importFailure(stage, error, archiveKey) })
    } finally {
      inFlight.current = false
    }
  }
  return { file: selection?.file, busy: feedback?.state === 'running', feedback, select, download,
    cancel: () => setSelection(null), confirm }
}

const stages: Record<ImportStage, [TranslationKey, TranslationKey]> = {
  reading: ['importReading', 'importReadFailed'],
  downloading: ['importDownloading', 'importDownloadFailed'],
  validating: ['importValidating', 'importValidationFailed'],
  snapshot: ['importSnapshot', 'importSnapshotFailed'],
  commit: ['importCommit', 'importCommitFailed'],
}

export const HistoryImportFeedback = ({ feedback }: { feedback: ImportFeedback | null }) => {
  const t = useTranslate()
  const locale = resolveLocale(useSettings((state) => state.locale))
  if (!feedback) { return null }
  if (feedback.state === 'success') {
    return <div className={styles.importFeedback} role="status" data-import-state="success">
      {t(feedback.count === 1 ? 'historyImportedOne' : 'historyImported', { count: feedback.count })}
    </div>
  }
  const [labelKey, failureKey] = stages[feedback.stage]
  if (feedback.state === 'failed') {
    const { reason, action, params } = feedback.failure
    return <div className={styles.importFeedback} role="alert" data-import-stage={feedback.stage} data-import-state="failed">
      <strong>{t(failureKey)}</strong>
      <p>{t(reason, params)} {t(action)}</p>
    </div>
  }
  const label = t(labelKey)
  const percent = importPercent(feedback.bytes)
  const bytes = feedback.bytes?.processed
  // Unknown-length downloads can still show the measured volume. Only announce the stage live.
  const metric = percent !== undefined ? `${percent}%` :
    feedback.stage === 'downloading' && bytes !== undefined && Number.isFinite(bytes) && bytes > 0
      ? t('importBytesReceived', { size: new Intl.NumberFormat(locale, { style: 'unit',
        unit: 'megabyte', maximumFractionDigits: 1 }).format(bytes / 1_000_000) }) : undefined
  return <div className={styles.importFeedback} data-import-stage={feedback.stage} data-import-state="running">
    <div className={styles.importStatusLine}>
      <strong role="status">{label}</strong>
      {metric && <span className={styles.importMetric} aria-hidden="true">{metric}</span>}
    </div>
    <div role="progressbar" className={styles.importProgressTrack} aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={metric}>
      <span className={styles.importProgressBar} style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </div>
  </div>
}
