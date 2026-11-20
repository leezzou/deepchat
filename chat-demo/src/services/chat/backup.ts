import { formatDate } from '../../utils/format.js'
import { createId } from '../../utils/id.js'
import { saveBlob } from '../../shell/saveFile.js'
import { MAX_ARCHIVE_BYTES } from './history/limits.js'
import type { ArchiveSource } from './history/archiveSource.js'
import { parseSessionPath } from './history/paths.js'
import { fail } from './history/errors.js'
import { useBackupState } from '../backup/state.js'
import {
  capturePortableMetadata,
  stagePortableMetadata,
  validatePortableMetadata,
  withMetadataRecovery,
  type PortableMetadata,
} from '../backup/portableMetadata.js'
import { MAX_PORTABLE_BYTES, PortableError } from '../backup/portableCrypto.js'
import {
  backupMetadata,
  changeAutomaticPreference,
  commitAutomaticBackup,
  countAutomaticRound,
  removeAutomaticCopy,
  readBackup,
  readBackupArtifacts,
  readBackupPreferences,
  readSnapshotParts,
  readSnapshotRecord,
  writeBackup,
  writeSafetySnapshot,
  type BackupArtifact,
  type BackupMetadata,
  type SnapshotPart,
} from '../backup/storage.js'
import * as db from './db.js'
import { flushChatPersistence, replaceHistory, useChatStore } from './store.js'
import { useSettings } from '../settings.js'
import type { Session } from './types.js'
import { captureDrafts, useDrafts } from './drafts.js'
import {
  compactionRecord,
  rebuildCompactionIndex,
  replaceCompactionIndex,
  type CompactionRecord,
} from './compactionIndex.js'

export { BackupError } from './history/errors.js'
export { useBackupState } from '../backup/state.js'

export class SnapshotError extends Error {
  constructor(cause: unknown) {
    super('Could not preserve the current history; no replacement was made.', { cause })
    this.name = 'SnapshotError'
  }
}

// 生成、保存、导入、恢复与全部删除共用队列，避免快照指针和替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()
const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}
const metadata = (reason: BackupMetadata['reason'], sessionCount: number): BackupMetadata => {
  const id = createId()
  const createdAt = Date.now()
  return {
    id,
    // 不同产物使用不同缓存文件名，避免原生分享尚在读取时被下一次保存覆盖。
    name: `deepseek_data-${formatDate(createdAt)}-${id.slice(0, 8)}.zip`,
    createdAt,
    sessionCount,
    reason,
    saveStatus: 'generated',
  }
}

let loadingState: Promise<void> | undefined
export const loadBackupState = (): Promise<void> =>
  (loadingState ??= (async () => {
    const [{ manual, automatic }, safety, preferences] = await Promise.all([
      readBackupArtifacts(),
      readSnapshotRecord(),
      readBackupPreferences(),
    ])
    useBackupState.setState({
      ready: true,
      latest: manual ? backupMetadata(manual) : null,
      automatic: automatic ? backupMetadata(automatic) : null,
      safety: safety ? backupMetadata(safety) : null,
      autoEnabled: preferences.autoEnabled,
      completedRounds: preferences.completedRounds,
      error: null,
    })
  })().catch((error: unknown) => {
    loadingState = undefined
    useBackupState.setState({ error: 'load' })
    throw error
  }))

/** 列表和已加载详情固定在开始时；未打开的会话逐条读取，不填满详情缓存。 */
async function* readCurrentSessions(): AsyncGenerator<Session> {
  const { sessions, sessionCache } = useChatStore.getState()
  for (const summary of sessions) {
    const session = Object.hasOwn(sessionCache, summary.id)
      ? sessionCache[summary.id]
      : await db.loadSession(summary.id)
    if (!session) {
      throw new Error(`History session disappeared during backup: ${summary.id}`)
    }
    yield { ...session, ...summary }
  }
}

const generateManualBackup = async (): Promise<BackupArtifact> => {
  await loadBackupState()
  if (!useChatStore.getState().ready) {
    throw new Error('History has not finished loading')
  }
  useBackupState.setState({ operation: 'generating' })
  try {
    const { exportArchive } = await import('./history/exportArchive.js')
    const info = metadata('manual', useChatStore.getState().sessions.length)
    const blob = await exportArchive(readCurrentSessions())
    const artifact = { ...info, blob }
    await writeBackup(artifact)
    useBackupState.setState({ latest: backupMetadata(artifact), error: null })
    return artifact
  } finally {
    useBackupState.setState({ operation: null })
  }
}

/** 生成可再次导入的 ZIP，并保留在本机。保存到文件由独立用户操作触发。 */
export const exportHistory = (): Promise<BackupArtifact> => enqueueBackup(generateManualBackup)

/** 分享或发起下载并不代表已持久保存；只记录系统实际返回的交付状态。 */
export const saveLatestBackup = () =>
  enqueueBackup(async () => {
    const artifact = await readBackup()
    if (!artifact) {
      throw new Error('No backup has been generated')
    }
    useBackupState.setState({ operation: 'saving' })
    try {
      const result = await saveBlob(artifact.name, artifact.blob)
      // 已确认保存的副本不会因为再次下载而降为未确认。
      if (artifact.saveStatus !== 'confirmed') {
        artifact.saveStatus = result.status
        await writeBackup(artifact)
        useBackupState.setState({ latest: backupMetadata(artifact) })
      }
      return result
    } finally {
      useBackupState.setState({ operation: null })
    }
  })

/** 只有用户核实文件后才写入“已确认保存”，系统分享完成不会调用此函数。 */
export const confirmBackupSaved = (id: string) =>
  enqueueBackup(async () => {
    const artifact = await readBackup()
    if (!artifact || artifact.id !== id) {
      throw new Error('The latest backup changed; save the new backup first')
    }
    await writeBackup({ ...artifact, saveStatus: 'confirmed', savedAt: Date.now() })
    useBackupState.setState({
      latest: { ...backupMetadata(artifact), saveStatus: 'confirmed', savedAt: Date.now() },
    })
  })

const currentIds = () => useChatStore.getState().sessions.map((session) => session.id)

async function* currentSnapshotParts(): AsyncGenerator<SnapshotPart> {
  yield { metadata: capturePortableMetadata(currentIds()) }
  for (const draft of captureDrafts()) {
    yield { draft }
  }
  const ids = new Set<string>()
  for await (const session of readCurrentSessions()) {
    const files: db.StoredFile[] = []
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (ids.has(file.id)) {
          continue
        }
        ids.add(file.id)
        const blob = await db.loadFile(file.id)
        if (blob) {
          files.push({ id: file.id, blob })
        }
      }
    }
    yield { session, files }
  }
}

/** 在 replaceHistory 的锁和持久写入屏障内调用，完整保留所有分支、元数据及可用附件原件。 */
const preserveCurrentHistory = async (reason: BackupMetadata['reason']) => {
  useBackupState.setState({ operation: 'snapshot' })
  try {
    const state = useChatStore.getState()
    if (
      !state.ready ||
      !useDrafts.getState().ready ||
      Object.keys(state.sessionSaveErrors).length
    ) {
      throw new Error('Current history has unsaved changes')
    }
    const info = metadata(reason, state.sessions.length)
    await writeSafetySnapshot(info, currentSnapshotParts())
    useBackupState.setState({ safety: info })
  } catch (error) {
    throw new SnapshotError(error)
  } finally {
    useBackupState.setState({ operation: null })
  }
}

const replaceHistoryAndIndex = async (write: () => Promise<void>) => {
  const count = await replaceHistory(write)
  // 派生列表不是历史事务的一部分；刷新索引失败不能把已成功替换误报为失败。
  await rebuildCompactionIndex().catch(() => {})
  return count
}

export type HistoryImportStage = 'reading' | 'validating' | 'snapshot' | 'commit'

/** 字节进度只描述当前阶段；完整校验和暂存成功后才创建快照并提交。 */
export const importHistory = (
  file: ArchiveSource,
  onProgress?: (processed: number, total: number) => void,
  onStage?: (stage: HistoryImportStage) => void
): Promise<number> =>
  enqueueBackup(() =>
    withMetadataRecovery(async () => {
      onStage?.('reading')
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      if (file.size > MAX_ARCHIVE_BYTES) {
        fail('importTooLarge')
      }
      // The picker already supplies a seekable File. Keeping the original avoids a second
      // archive-sized Chromium Blob allocation before the first conversation can be staged.
      const directory = await checkArchiveFormat(file)
      onStage?.('validating')
      const compactions: CompactionRecord[] = []
      const count = await replaceHistory(async () => {
        await importArchive(file, directory, onProgress, (session) => {
          const record = compactionRecord(session)
          if (record) {
            compactions.push(record)
          }
        })
        onStage?.('snapshot')
        await preserveCurrentHistory('before-import')
        // Ordinary ZIPs carry no library bindings. Preserve the user's folders,
        // memories and templates, discarding references to the replaced history.
        await stagePortableMetadata(
          capturePortableMetadata([]),
          directory.entries.flatMap((entry) => {
            const id = parseSessionPath(entry.path)
            return id === null ? [] : [id]
          }),
          currentIds()
        )
        onStage?.('commit')
      })
      replaceCompactionIndex(compactions)
      return count
    })
  )

/** 清空前必须成功保留快照；API Key 和其他设置不在备份或替换范围内。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(() =>
    withMetadataRecovery(async () => {
      await replaceHistoryAndIndex(async () => {
        await preserveCurrentHistory('before-clear')
        await stagePortableMetadata(capturePortableMetadata([]), [], currentIds())
      })
    })
  )

/** 恢复前另存当前历史；恢复后安全快照指向恢复前的状态，可以撤回这次恢复。 */
export const restoreSafetySnapshot = (): Promise<number> =>
  enqueueBackup(() =>
    withMetadataRecovery(async () => {
      const target = await readSnapshotRecord()
      if (!target) {
        throw new Error('No safety snapshot is available')
      }
      try {
        const drafts: ReturnType<typeof captureDrafts> = []
        const targetIds: string[] = []
        let targetMetadata: PortableMetadata | undefined
        const count = await replaceHistoryAndIndex(async () => {
          useBackupState.setState({ operation: 'restoring' })
          for await (const part of readSnapshotParts(target)) {
            if (part.metadata) {
              targetMetadata = part.metadata
            }
            if (part.session) {
              targetIds.push(part.session.id)
              await db.addStagingSession(part.session)
            }
            if (part.draft) {
              drafts.push(part.draft)
            }
            if (part.files?.length) {
              await db.saveStagingFiles(part.files)
            }
          }
          const validated = targetMetadata && validatePortableMetadata(targetMetadata, targetIds)
          await preserveCurrentHistory('before-restore')
          await stagePortableMetadata(
            validated ?? capturePortableMetadata([]),
            targetIds,
            currentIds(),
            drafts
          )
        })
        return count
      } finally {
        useBackupState.setState({ operation: null })
      }
    })
  )

/** Portable backup reuses the v3 ZIP writer, enabling stable message IDs so favorites travel. */
export const exportPortableHistory = () =>
  enqueueBackup(async () => {
    if (!useChatStore.getState().ready) {
      throw new PortableError('local')
    }
    const metadata = capturePortableMetadata(currentIds())
    const { exportArchive } = await import('./history/exportArchive.js')
    const zip = await exportArchive(readCurrentSessions(), db.loadFile, true)
    return { zip, metadata }
  })

export const restorePortableHistory = (file: File, value: unknown, stillOpen = () => true) =>
  enqueueBackup(() =>
    withMetadataRecovery(async () => {
      const checkOpen = () => {
        if (!stillOpen()) {
          throw new DOMException('Cancelled', 'AbortError')
        }
      }
      checkOpen()
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      const directory = await checkArchiveFormat(file)
      if (directory.entries.reduce((total, entry) => total + entry.size, 0) > MAX_PORTABLE_BYTES) {
        throw new PortableError('large')
      }
      const ids: string[] = []
      checkOpen()
      return replaceHistoryAndIndex(async () => {
        await importArchive(file, directory, checkOpen, (session) => ids.push(session.id))
        const metadata = validatePortableMetadata(value, ids)
        checkOpen()
        await preserveCurrentHistory('before-restore')
        checkOpen()
        await stagePortableMetadata(metadata, ids, currentIds())
        checkOpen()
      })
    })
  )

export const saveSafetySnapshot = () =>
  enqueueBackup(async () => {
    const target = await readSnapshotRecord()
    if (!target) {
      throw new Error('No safety snapshot is available')
    }
    useBackupState.setState({ operation: 'saving' })
    try {
      const { exportArchive } = await import('./history/exportArchive.js')
      const originals = new Map<string, Blob>()
      const parts = readSnapshotParts(target)
      const sessions = (async function* () {
        for await (const { session, files } of parts) {
          for (const file of files ?? []) {
            originals.set(file.id, file.blob)
          }
          if (session) {
            yield session
          }
        }
      })()
      const blob = await exportArchive(sessions, async (id) => originals.get(id))
      return await saveBlob(target.name, blob)
    } finally {
      useBackupState.setState({ operation: null })
    }
  })

// Privacy actions bypass the archive queue: an expensive ZIP must never delay opt-out.
let automaticEpoch = 0
let working: AbortController | undefined
let privacyActions = 0
let channel: BroadcastChannel | undefined

/** Refresh open settings when a second window changes the device-wide preference or copy. */
export const observeAutomaticSettings = () => {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('chat-demo:automatic-backup')
  }
  const refresh = async () => {
    if (document.hidden || privacyActions) {
      return
    }
    try {
      await loadBackupState()
      const [{ automatic }, p] = await Promise.all([readBackupArtifacts(), readBackupPreferences()])
      if (privacyActions) {
        return
      }
      useBackupState.setState({
        automatic: automatic ? backupMetadata(automatic) : null,
        autoEnabled: p.autoEnabled,
        completedRounds: p.completedRounds,
      })
    } catch {
      useBackupState.setState({ error: 'load' })
    }
  }
  if (channel) {
    channel.onmessage = refresh
  }
  document.addEventListener('visibilitychange', refresh)
  return () => {
    document.removeEventListener('visibilitychange', refresh)
    channel?.close()
    channel = undefined
  }
}
const cancelAutomaticWork = () => {
  automaticEpoch++
  working?.abort()
}

const manageAutomatic = async (enabled?: boolean) => {
  const deleting = enabled === undefined
  privacyActions++
  cancelAutomaticWork()
  try {
    await loadBackupState()
    const p = deleting ? await removeAutomaticCopy() : await changeAutomaticPreference(enabled)
    useBackupState.setState({
      autoEnabled: p.autoEnabled,
      completedRounds: p.completedRounds,
      ...(deleting && { automatic: null }),
      error: null,
    })
    channel?.postMessage('changed')
  } finally {
    privacyActions--
  }
}
export const setAutomaticBackup = (enabled: boolean) => manageAutomatic(enabled)
export const deleteAutomaticBackup = () => manageAutomatic()

/** Only an explicit tap in settings can open the system save/share UI. */
export const saveAutomaticBackup = async () => {
  const { automatic } = await readBackupArtifacts()
  if (!automatic) {
    throw new Error('No automatic backup is available')
  }
  return saveBlob(automatic.name, automatic.blob)
}

const buildAutomaticArchive = async (ids: string[], signal: AbortSignal): Promise<Blob> => {
  const worker = new Worker(new URL('../backup/automaticArchive.worker.ts', import.meta.url))
  const abortError = () => new DOMException('Cancelled', 'AbortError')
  let abort: (() => void) | undefined
  try {
    return await new Promise<Blob>((resolve, reject) => {
      abort = () => reject(abortError())
      if (signal.aborted) {
        return abort()
      }
      signal.addEventListener('abort', abort, { once: true })
      worker.onmessage = ({ data }) =>
        data?.blob instanceof Blob
          ? resolve(data.blob)
          : reject(new Error('Could not build local ZIP'))
      worker.onerror = (event) => {
        event.preventDefault()
        reject(new Error('Could not build local ZIP'))
      }
      worker.postMessage({ ids, locale: useSettings.getState().locale })
    })
  } finally {
    if (abort) {
      signal.removeEventListener('abort', abort)
    }
    worker.terminate()
  }
}

/** Count only completions observed live. The queue orders exports against imports and restores,
 * but never enters the foreground operation state or disables the conversation or settings. */
export const recordCompletedBackupRound = (roundId: string): Promise<boolean> => {
  const epoch = automaticEpoch
  if (privacyActions) {
    return Promise.resolve(false)
  }
  return enqueueBackup(async () => {
    await loadBackupState()
    if (epoch !== automaticEpoch) {
      return false
    }
    const { due, preferences } = await countAutomaticRound(roundId)
    if (epoch !== automaticEpoch) {
      return false
    }
    useBackupState.setState({
      autoEnabled: preferences.autoEnabled,
      completedRounds: preferences.completedRounds,
    })
    if (!due) {
      return false
    }
    const controller = new AbortController()
    working = controller
    try {
      // The final reply is persisted immediately after the store's completion notification.
      await flushChatPersistence()
      if (controller.signal.aborted) {
        return false
      }
      const ids = currentIds()
      if (!ids.length) {
        return false
      }
      const info = metadata('automatic', ids.length)
      const blob = await buildAutomaticArchive(ids, controller.signal)
      if (controller.signal.aborted) {
        return false
      }
      const p = await commitAutomaticBackup({ ...info, blob }, preferences.revision ?? 0)
      if (!p) {
        return false
      }
      // A concurrent disable retains an already-committed ZIP. A delete clears it afterwards.
      useBackupState.setState({ automatic: info })
      if (controller.signal.aborted) {
        return false
      }
      useBackupState.setState({ completedRounds: p.completedRounds, error: null })
      channel?.postMessage('changed')
      return true
    } catch (error) {
      if (controller.signal.aborted) {
        return false
      }
      throw error
    } finally {
      working = undefined
    }
  })
}
