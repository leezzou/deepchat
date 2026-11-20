import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type { StoredFile } from '../chat/db.js'
import type { Session } from '../chat/types.js'
import type { StoredDraft } from '../chat/draftStorage.js'
import type { PortableMetadata } from './portableMetadata.js'

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
  /** Invalidates in-flight writers after disabling, deleting or committing a backup. */
  revision?: number
  /** 按用户轮次去重，重试/续写不重复计数；只保留最近的记录。 */
  recentRoundIds: string[]
}

export type SnapshotPart = {
  session?: Session
  files?: StoredFile[]
  draft?: StoredDraft
  metadata?: PortableMetadata
}
type SnapshotPointer = BackupMetadata & { parts: number }
type SnapshotRecord = SafetySnapshot | SnapshotPointer
type SnapshotSlot = 'latest' | 'previous'

interface BackupDB extends DBSchema {
  artifacts: { key: 'latest' | 'automatic'; value: BackupArtifact }
  snapshots: { key: SnapshotSlot | 'pending'; value: SnapshotPointer | { legacy: SnapshotSlot } }
  legacySnapshots: { key: SnapshotSlot; value: SafetySnapshot }
  snapshotParts: { key: [string, number]; value: SnapshotPart }
  preferences: { key: 'settings'; value: BackupPreferences }
}

let connection: Promise<IDBPDatabase<BackupDB>> | undefined
const getDB = () =>
  (connection ??= openDB<BackupDB>('chat-demo-backups', 2, {
    upgrade(db, oldVersion, _, tx) {
      if (oldVersion === 0) {
        db.createObjectStore('artifacts')
        db.createObjectStore('preferences')
        db.createObjectStore('legacySnapshots')
      } else {
        // 只重命名 v1 存储，迁移和后续轮换均无需读回或复制旧的整份快照。
        tx.objectStore('snapshots').name = 'legacySnapshots'
      }
      const slots = db.createObjectStore('snapshots')
      db.createObjectStore('snapshotParts')
      if (oldVersion === 1) {
        void tx
          .objectStore('legacySnapshots')
          .getAllKeys()
          .then(async (keys) => {
            for (const key of keys) {
              await slots.put({ legacy: key }, key)
            }
          })
          .catch(() => tx.abort())
      }
    },
  }).catch((error: unknown) => {
    connection = undefined
    throw error
  }))

// Earlier versions shared `latest` between manual and automatic exports. Read old copies
// in place, including on a full device where copying a ZIP during an upgrade could fail.
export const readBackupArtifacts = async () => {
  const tx = (await getDB()).transaction('artifacts')
  const [latest, automatic] = await Promise.all([tx.store.get('latest'), tx.store.get('automatic')])
  return {
    manual: latest?.reason === 'automatic' ? undefined : latest,
    automatic: automatic ?? (latest?.reason === 'automatic' ? latest : undefined),
  }
}
export const readBackup = async () => (await readBackupArtifacts()).manual

export const readSnapshotRecord = async (): Promise<SnapshotRecord | undefined> => {
  const tx = (await getDB()).transaction(['snapshots', 'legacySnapshots'])
  const slot = await tx.objectStore('snapshots').get('latest')
  return slot && 'legacy' in slot ? tx.objectStore('legacySnapshots').get(slot.legacy) : slot
}

export async function* readSnapshotParts(record: SnapshotRecord): AsyncGenerator<SnapshotPart> {
  if ('sessions' in record) {
    // v1 快照已由 IDB 整条读出。先交付原件，供按会话导出时查询。
    for (let i = 0; i < record.files.length; i += 8) {
      yield { files: record.files.slice(i, i + 8) }
    }
    for (const draft of record.drafts ?? []) {
      yield { draft }
    }
    for (const session of record.sessions) {
      yield { session }
    }
    return
  }
  const db = await getDB()
  for (let index = 0; index < record.parts; index++) {
    const part = await db.get('snapshotParts', [record.id, index])
    if (!part) {
      throw new Error('Safety snapshot is incomplete')
    }
    yield part
  }
}

/** 兼容需要完整本地快照的旧调用；列表、导入、恢复和保存均直接使用指针/分片。 */
export const readSafetySnapshot = async (): Promise<SafetySnapshot | undefined> => {
  const record = await readSnapshotRecord()
  if (!record || 'sessions' in record) {
    return record
  }
  const result: SafetySnapshot & { drafts: StoredDraft[] } = {
    ...backupMetadata(record),
    sessions: [],
    files: [],
    drafts: [],
  }
  for await (const { session, draft, files } of readSnapshotParts(record)) {
    if (session) {
      result.sessions.push(session)
    }
    if (draft) {
      result.drafts.push(draft)
    }
    for (const file of files ?? []) {
      result.files.push(file)
    }
  }
  return result
}
const defaults = (): BackupPreferences => ({
  autoEnabled: true,
  completedRounds: 0,
  recentRoundIds: [],
})
export const readBackupPreferences = async (): Promise<BackupPreferences> => {
  const current = (await (await getDB()).get('preferences', 'settings')) ?? defaults()
  if (current.autoEnabled || (!current.recentRoundIds.length && !current.completedRounds)) {
    return current
  }
  // Older builds continued to remember round IDs while disabled. Scrub those at first read,
  // rechecking inside the transaction so a concurrent opt-in is never overwritten.
  return autoTransaction(async (tx) => {
    const p = await preferencesIn(tx)
    if (!p.autoEnabled && (p.recentRoundIds.length || p.completedRounds)) {
      resetRounds(p)
      await tx.objectStore('preferences').put(p, 'settings')
    }
    return p
  })
}

const autoStores = ['preferences', 'artifacts'] as const
type AutoTx = IDBPTransaction<BackupDB, typeof autoStores, 'readwrite'>
// A quota error or synchronous IndexedDB exception must roll back every change, including deletion.
async function autoTransaction<T>(run: (tx: AutoTx) => Promise<T>): Promise<T> {
  const tx = (await getDB()).transaction(autoStores, 'readwrite')
  try {
    const [result] = await Promise.all([run(tx), tx.done])
    return result
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* transaction already aborted */
    }
    await tx.done.catch(() => {})
    throw error
  }
}
const preferencesIn = async (tx: AutoTx) =>
  (await tx.objectStore('preferences').get('settings')) ?? defaults()
const resetRounds = (p: BackupPreferences) => {
  p.completedRounds = 0
  p.recentRoundIds = []
  p.revision = (p.revision ?? 0) + 1
}

export const changeAutomaticPreference = (enabled: boolean) =>
  autoTransaction(async (tx) => {
    const p = await preferencesIn(tx)
    if (p.autoEnabled !== enabled || (!enabled && (p.recentRoundIds.length || p.completedRounds))) {
      resetRounds(p)
      p.autoEnabled = enabled
      await tx.objectStore('preferences').put(p, 'settings')
    }
    return p
  })

export const AUTO_INTERVAL = 10
export const countAutomaticRound = (roundId: string) =>
  autoTransaction(async (tx) => {
    const p = await preferencesIn(tx)
    if (!p.autoEnabled || p.recentRoundIds.includes(roundId)) {
      return { due: false, preferences: p }
    }
    p.recentRoundIds = [...p.recentRoundIds.slice(-199), roundId]
    p.completedRounds += 1
    await tx.objectStore('preferences').put(p, 'settings')
    return { due: p.completedRounds >= AUTO_INTERVAL, preferences: p }
  })

export const commitAutomaticBackup = (artifact: BackupArtifact, revision: number) =>
  autoTransaction(async (tx) => {
    const p = await preferencesIn(tx)
    if (!p.autoEnabled || (p.revision ?? 0) !== revision || p.completedRounds < AUTO_INTERVAL) {
      return null
    }
    const artifacts = tx.objectStore('artifacts')
    if ((await artifacts.get('latest'))?.reason === 'automatic') {
      await artifacts.delete('latest')
    }
    await artifacts.put(artifact, 'automatic')
    p.completedRounds %= AUTO_INTERVAL
    p.revision = revision + 1
    await tx.objectStore('preferences').put(p, 'settings')
    return p
  })

export const removeAutomaticCopy = () =>
  autoTransaction(async (tx) => {
    const artifacts = tx.objectStore('artifacts')
    if ((await artifacts.get('latest'))?.reason === 'automatic') {
      await artifacts.delete('latest')
    }
    await artifacts.delete('automatic')
    const p = await preferencesIn(tx)
    resetRounds(p)
    await tx.objectStore('preferences').put(p, 'settings')
    return p
  })

export const writeBackup = (artifact: BackupArtifact) =>
  autoTransaction(async (tx) => {
    const artifacts = tx.objectStore('artifacts')
    const old = await artifacts.get('latest')
    if (old?.reason === 'automatic' && !(await artifacts.count('automatic'))) {
      await artifacts.put(old, 'automatic')
    }
    await artifacts.put(artifact, 'latest')
  })

const snapshotStores = ['snapshots', 'snapshotParts', 'legacySnapshots'] as const
type SnapshotTx = IDBPTransaction<BackupDB, typeof snapshotStores, 'readwrite'>
const snapshotTransaction = async (run: (tx: SnapshotTx) => Promise<void>) => {
  const tx = (await getDB()).transaction(snapshotStores, 'readwrite')
  try {
    await Promise.all([run(tx), tx.done])
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* 异步失败的请求已中止事务。 */
    }
    await tx.done.catch(() => {})
    throw error
  }
}
const dropParts = (tx: SnapshotTx, id: string) =>
  tx.objectStore('snapshotParts').delete(IDBKeyRange.bound([id, 0], [id, Infinity]))

/** 先逐条暂存，最后一个事务同时轮换两代快照。pending 使中断可回收，并防止并发写错代。 */
const stageSnapshot = async (info: BackupMetadata, parts: AsyncIterable<SnapshotPart>) => {
  const pointer: SnapshotPointer = { ...info, parts: 0 }
  await snapshotTransaction(async (tx) => {
    const store = tx.objectStore('snapshots')
    const interrupted = await store.get('pending')
    if (interrupted && 'id' in interrupted) {
      await dropParts(tx, interrupted.id)
    }
    await store.put(pointer, 'pending')
  })
  const checkOwner = async (tx: SnapshotTx) => {
    const owner = await tx.objectStore('snapshots').get('pending')
    if (!owner || !('id' in owner) || owner.id !== info.id) {
      throw new Error('Safety snapshot was superseded')
    }
  }
  try {
    for await (const part of parts) {
      await snapshotTransaction(async (tx) => {
        await checkOwner(tx)
        await tx.objectStore('snapshotParts').add(part, [info.id, pointer.parts++])
      })
    }
    await snapshotTransaction(async (tx) => {
      await checkOwner(tx)
      const store = tx.objectStore('snapshots')
      const previous = await store.get('previous')
      if (previous) {
        if ('legacy' in previous) {
          await tx.objectStore('legacySnapshots').delete(previous.legacy)
        } else {
          await dropParts(tx, previous.id)
        }
      }
      const latest = await store.get('latest')
      if (latest) {
        await store.put(latest, 'previous')
      }
      await store.put(pointer, 'latest')
      await store.delete('pending')
    })
  } catch (error) {
    // 页面关闭或清理本身失败时，下次写入会清理遗留的 pending。
    await snapshotTransaction(async (tx) => {
      await checkOwner(tx)
      await dropParts(tx, info.id)
      await tx.objectStore('snapshots').delete('pending')
    }).catch(() => {})
    throw error
  }
}

/** 支持 Web Locks 的多页环境串行写同一快照库。页面关闭后锁由浏览器释放。 */
export const writeSafetySnapshot = (info: BackupMetadata, parts: AsyncIterable<SnapshotPart>) =>
  navigator.locks
    ? navigator.locks.request('chat-demo:safety-snapshot', () => stageSnapshot(info, parts))
    : stageSnapshot(info, parts)

export const backupMetadata = (artifact: BackupMetadata): BackupMetadata => ({
  id: artifact.id,
  name: artifact.name,
  createdAt: artifact.createdAt,
  sessionCount: artifact.sessionCount,
  reason: artifact.reason,
  saveStatus: artifact.saveStatus,
  ...(artifact.savedAt === undefined ? {} : { savedAt: artifact.savedAt }),
})
