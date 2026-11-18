import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { HistoryImportStage } from '../../services/chat/backup.js'

export type ImportStage = HistoryImportStage | 'downloading'
export type ImportSource = 'file' | 'link'
export type ImportBytes = { processed: number; total: number }
export type ImportFailure = { reason: TranslationKey; action: TranslationKey; params?: TranslationParams }
export type ImportFeedback = { source: ImportSource } & (
  | { state: 'running'; stage: ImportStage; bytes?: ImportBytes }
  | { state: 'failed'; stage: ImportStage; failure: ImportFailure }
  | { state: 'success'; count: number }
)

// Content-Length can be absent, negative, or smaller than the decoded payload.
export const importPercent = (bytes?: ImportBytes) => {
  if (!bytes || !Number.isFinite(bytes.processed) || !Number.isFinite(bytes.total) ||
      bytes.total <= 0 || bytes.processed < 0 || bytes.processed > bytes.total) {
    return undefined
  }
  return Math.floor(bytes.processed / bytes.total * 100)
}

const archiveFailures: Partial<Record<TranslationKey, ImportFailure>> = {
  backupUnrecognized: { reason: 'importFormatError', action: 'importArchiveAction' },
  backupNewerVersion: { reason: 'importVersionError', action: 'importUpdateAction' },
  backupInvalidVersion: { reason: 'backupInvalidVersion', action: 'importArchiveAction' },
  backupIncomplete: { reason: 'backupIncomplete', action: 'importArchiveAction' },
  backupInvalidJson: { reason: 'backupInvalidJson', action: 'importArchiveAction' },
  backupInvalidBranches: { reason: 'backupInvalidBranches', action: 'importArchiveAction' },
  backupInvalidFiles: { reason: 'backupInvalidFiles', action: 'importArchiveAction' },
}

/** Project exceptions to local copy. No URL, native exception text, or archive data is rendered. */
export const importFailure = (
  stage: ImportStage,
  error: unknown,
  archiveKey?: TranslationKey,
): { stage: ImportStage; failure: ImportFailure } => {
  const failed = (reason: TranslationKey, action: TranslationKey, params?: TranslationParams) =>
    ({ stage, failure: { reason, action, params } })
  if (archiveKey === 'importTooLarge' || (error instanceof Error && error.name === 'ArchiveSizeError')) {
    return failed('importTooLarge', 'importChooseSmaller')
  }
  if (archiveKey && archiveFailures[archiveKey]) {
    return { stage: 'validating', failure: archiveFailures[archiveKey] }
  }
  let cause = error
  const details: string[] = []
  for (let i = 0; cause && i < 4; i++) {
    if (typeof cause === 'string') {
      details.push(cause)
      break
    }
    if (typeof cause !== 'object') { break }
    const { name, message, cause: nested } = cause as Partial<Error>
    details.push(`${name ?? ''} ${message ?? ''}`)
    cause = nested
  }
  const detail = details.join('\n')
  if (/QuotaExceededError|no space left|disk (?:is )?full|ENOSPC/i.test(detail)) {
    return failed('importQuotaError', 'importSpaceAction')
  }
  if (/failed to write blobs?/i.test(detail)) {
    return failed('importBlobError', 'importStorageAction')
  }
  if (/out of memory|allocation failed|invalid string length/i.test(detail)) {
    return failed('importMemoryError', 'importMemoryAction')
  }
  if (stage === 'downloading') {
    if (/本地文件读取失败|local cache read/i.test(detail)) {
      return failed('importReadError', 'importReadAction')
    }
    const status = /\b(?:HTTP(?:\/\d(?:\.\d)?)?|response code:?)\s+([45]\d{2})\b/i.exec(detail)
    if (status) {
      const code = Number(status[1])
      return [401, 403, 404, 410].includes(code)
        ? failed('importHttpDenied', 'importRenewLink', { code })
        : failed('importHttpOther', 'importDownloadAction', { code })
    }
    return failed('importNetwork', 'importDownloadAction')
  }
  if (/unsaved changes|could not be saved/i.test(detail)) {
    return failed('importUnsavedError', 'importWaitAction')
  }
  if (/replacement is already in progress|another page started a history replacement/i.test(detail)) {
    return failed('importBusyError', 'importWaitAction')
  }
  if (stage === 'reading' || /NotReadableError|NotFoundError/.test(detail)) {
    return failed('importReadError', 'importReadAction')
  }
  if (stage === 'commit' || /UnknownError|QuotaExceededError|AbortError|TransactionInactiveError|InvalidStateError/.test(detail)) {
    return failed('importStorageError', 'importStorageAction')
  }
  if (stage === 'snapshot') {
    return failed('importSnapshotError', 'importStorageAction')
  }
  return failed('importValidationError', 'importArchiveAction')
}
