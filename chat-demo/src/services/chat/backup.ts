import { formatDate } from '../../utils/format.js'
import { createId } from '../../utils/id.js'
import { saveBlob } from '../../shell/saveFile.js'
import { useBackupState } from '../backup/state.js'
import {
  backupMetadata,
  readBackup,
  readBackupPreferences,
  readSafetySnapshot,
  writeBackup,
  writeBackupPreferences,
  writeSafetySnapshot,
  type BackupArtifact,
  type BackupMetadata,
  type SafetySnapshot,
} from '../backup/storage.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'
import { captureDrafts, restoreDrafts, useDrafts } from './drafts.js'
import { rebuildCompactionIndex } from './compactionIndex.js'

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
    const [latest, safety, preferences] = await Promise.all([
      readBackup(),
      readSafetySnapshot(),
      readBackupPreferences(),
    ])
    useBackupState.setState({
      ready: true,
      latest: latest ? backupMetadata(latest) : null,
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

const generateBackup = async (reason: 'manual' | 'automatic'): Promise<BackupArtifact> => {
  await loadBackupState()
  if (!useChatStore.getState().ready) {
    throw new Error('History has not finished loading')
  }
  useBackupState.setState({ operation: 'generating' })
  try {
    const { exportArchive } = await import('./history/exportArchive.js')
    const info = metadata(reason, useChatStore.getState().sessions.length)
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
export const exportHistory = (): Promise<BackupArtifact> =>
  enqueueBackup(() => generateBackup('manual'))

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

/** 在 replaceHistory 的锁和持久写入屏障内调用，完整保留所有分支、元数据及可用附件原件。 */
const preserveCurrentHistory = async (reason: SafetySnapshot['reason']) => {
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
    const sessions: Session[] = []
    const files: db.StoredFile[] = []
    const ids = new Set<string>()
    for await (const session of readCurrentSessions()) {
      sessions.push(session)
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
    }
    const snapshot: SafetySnapshot = {
      ...metadata(reason, sessions.length),
      sessions,
      files,
      drafts: captureDrafts(),
    }
    await writeSafetySnapshot(snapshot)
    useBackupState.setState({ safety: backupMetadata(snapshot) })
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

/** 完整校验和暂存成功后才创建快照；坏包不覆盖旧快照，快照失败不提交历史替换。 */
export const importHistory = (
  file: File,
  onProgress?: (processed: number, total: number) => void
): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistoryAndIndex(async () => {
      await importArchive(file, onProgress)
      await preserveCurrentHistory('before-import')
    })
  })

/** 清空前必须成功保留快照；API Key 和其他设置不在备份或替换范围内。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistoryAndIndex(() => preserveCurrentHistory('before-clear'))
  })

/** 恢复前另存当前历史；恢复后安全快照指向恢复前的状态，可以撤回这次恢复。 */
export const restoreSafetySnapshot = (): Promise<number> =>
  enqueueBackup(async () => {
    const target = await readSafetySnapshot()
    if (!target) {
      throw new Error('No safety snapshot is available')
    }
    try {
      const count = await replaceHistoryAndIndex(async () => {
        await preserveCurrentHistory('before-restore')
        useBackupState.setState({ operation: 'restoring' })
        for (let index = 0; index < target.sessions.length; index += 20) {
          await db.addStagingSessions(target.sessions.slice(index, index + 20))
        }
        for (let index = 0; index < target.files.length; index += 8) {
          await db.saveStagingFiles(target.files.slice(index, index + 8))
        }
      })
      await restoreDrafts(target.drafts ?? [])
      return count
    } finally {
      useBackupState.setState({ operation: null })
    }
  })

export const saveSafetySnapshot = () =>
  enqueueBackup(async () => {
    const target = await readSafetySnapshot()
    if (!target) {
      throw new Error('No safety snapshot is available')
    }
    useBackupState.setState({ operation: 'saving' })
    try {
      const { exportArchive } = await import('./history/exportArchive.js')
      const originals = new Map(target.files.map((file) => [file.id, file.blob]))
      const blob = await exportArchive(target.sessions, async (id) => originals.get(id))
      return await saveBlob(target.name, blob)
    } finally {
      useBackupState.setState({ operation: null })
    }
  })

export const setAutomaticBackup = (autoEnabled: boolean) =>
  enqueueBackup(async () => {
    await loadBackupState()
    const preferences = await readBackupPreferences()
    await writeBackupPreferences({ ...preferences, autoEnabled })
    useBackupState.setState({ autoEnabled })
  })

/** 仅由运行中的请求完成事件调用；失败/停止/旧历史加载都不增加计数。 */
export const recordCompletedBackupRound = (roundId: string): Promise<boolean> =>
  enqueueBackup(async () => {
    await loadBackupState()
    const preferences = await readBackupPreferences()
    if (preferences.recentRoundIds.includes(roundId)) {
      return false
    }
    preferences.recentRoundIds = [...preferences.recentRoundIds.slice(-199), roundId]
    if (preferences.autoEnabled) {
      preferences.completedRounds += 1
    }
    await writeBackupPreferences(preferences)
    useBackupState.setState({ completedRounds: preferences.completedRounds })
    if (!preferences.autoEnabled || preferences.completedRounds < 10) {
      return false
    }
    await generateBackup('automatic')
    preferences.completedRounds %= 10
    await writeBackupPreferences(preferences)
    useBackupState.setState({ completedRounds: preferences.completedRounds })
    return true
  })
