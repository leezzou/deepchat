import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { StoredFile } from '../chat/db.js'
import type { Session } from '../chat/types.js'
import type { StoredDraft } from '../chat/draftStorage.js'

export type BackupSaveStatus = 'generated' | 'download-requested' | 'shared' | 'confirmed'
export type BackupMetadata = {
  id: string
  name: string
  createdAt: number
  sessionCount: number
  reason: 'manual' | 'automatic' | 'before-import' | 'before-clear' | 'before-restore'
  saveStatus: BackupSaveStatus
  savedAt?: number
}
export type BackupArtifact = BackupMetadata & { blob: Blob }
export type SafetySnapshot = BackupMetadata & {
  sessions: Session[]
  files: StoredFile[]
  drafts?: StoredDraft[]
}
export type BackupPreferences = {
  autoEnabled: boolean
  completedRounds: number
  /** 按用户轮次去重，重试/续写不重复计数；只保留最近的记录。 */
  recentRoundIds: string[]
}

interface BackupDB extends DBSchema {
  artifacts: { key: 'latest'; value: BackupArtifact }
  snapshots: { key: 'latest' | 'previous'; value: SafetySnapshot }
  preferences: { key: 'settings'; value: BackupPreferences }
}

let connection: Promise<IDBPDatabase<BackupDB>> | undefined
const getDB = () =>
  (connection ??= openDB<BackupDB>('chat-demo-backups', 1, {
    upgrade(db) {
      db.createObjectStore('artifacts')
      db.createObjectStore('snapshots')
      db.createObjectStore('preferences')
    },
  }).catch((error: unknown) => {
    connection = undefined
    throw error
  }))

export const readBackup = async () => (await getDB()).get('artifacts', 'latest')
export const readSafetySnapshot = async () => (await getDB()).get('snapshots', 'latest')
export const readBackupPreferences = async (): Promise<BackupPreferences> =>
  (await (await getDB()).get('preferences', 'settings')) ?? {
    autoEnabled: true,
    completedRounds: 0,
    recentRoundIds: [],
  }

export const writeBackup = async (artifact: BackupArtifact) => {
  const tx = (await getDB()).transaction('artifacts', 'readwrite')
  await Promise.all([tx.store.put(artifact, 'latest'), tx.done])
}

/** 单个事务成功才替换指针；配额/写入失败时旧快照及其前一份都保持不变。 */
export const writeSafetySnapshot = async (snapshot: SafetySnapshot) => {
  const tx = (await getDB()).transaction('snapshots', 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const previous = await tx.store.get('latest')
        if (previous) {
          await tx.store.put(previous, 'previous')
        }
        await tx.store.put(snapshot, 'latest')
      } catch (error) {
        try {
          tx.abort()
        } catch {
          /* 已被失败请求中止。 */
        }
        throw error
      }
    })(),
    tx.done,
  ])
}

export const writeBackupPreferences = async (preferences: BackupPreferences) => {
  const tx = (await getDB()).transaction('preferences', 'readwrite')
  await Promise.all([tx.store.put(preferences, 'settings'), tx.done])
}

export const backupMetadata = (artifact: BackupMetadata): BackupMetadata => ({
  id: artifact.id,
  name: artifact.name,
  createdAt: artifact.createdAt,
  sessionCount: artifact.sessionCount,
  reason: artifact.reason,
  saveStatus: artifact.saveStatus,
  ...(artifact.savedAt === undefined ? {} : { savedAt: artifact.savedAt }),
})
