import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb'
import { createId } from '../../utils/id.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

const DB_VERSION = 12

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份。 */
export type StoredFile = { id: string; blob: Blob }

type StoredSessionSummary = SessionSummary & { fileIds: string[] }
type SummaryStore = { key: string; value: StoredSessionSummary; indexes: { fileIds: string } }
type Generation = 0 | 1

interface ChatDB extends DBSchema {
  sessions: { key: string; value: Session }
  sessionsStaging: { key: string; value: Session }
  sessionSummaries: SummaryStore
  sessionSummariesStaging: SummaryStore
  files: { key: string; value: StoredFile }
  filesStaging: { key: string; value: StoredFile }
  historyMeta: { key: 'active' | 'writer'; value: Generation | string }
}

// v11 的正式存储原地作为第 0 代。一次导入始终只写另一代，最后仅提交 active 指针。
const sessions = ['sessions', 'sessionsStaging'] as const
const summaries = ['sessionSummaries', 'sessionSummariesStaging'] as const
const files = ['files', 'filesStaging'] as const
const allData = [...sessions, ...summaries, ...files]
const other = (generation: Generation): Generation => (generation === 0 ? 1 : 0)

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      for (const name of [...sessions, ...files]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      for (const name of summaries) {
        const store = db.objectStoreNames.contains(name)
          ? tx.objectStore(name)
          : db.createObjectStore(name, { keyPath: 'id' })
        if (!store.indexNames.contains('fileIds')) {
          store.createIndex('fileIds', 'fileIds', { multiEntry: true })
        }
      }
      if (!db.objectStoreNames.contains('historyMeta')) {
        db.createObjectStore('historyMeta')
      }
    },
  }).catch((error: unknown) => {
    dbPromise = null
    throw error
  }))

type Store = StoreNames<ChatDB>
type Mode = 'readonly' | 'readwrite'
type Tx<M extends Mode> = IDBPTransaction<ChatDB, Store[], M>

// 选择代和访问实体必须在同一事务中，包括其他页面正在切换 active 的情况。
const transact = async <M extends Mode, T>(
  stores: readonly Store[],
  mode: M,
  run: (tx: Tx<M>, active: Generation) => Promise<T>
): Promise<T> => {
  const scope: Store[] = ['historyMeta', ...stores]
  const tx = (await getDB()).transaction(scope, mode)
  const work = async () => {
    try {
      const active = (await tx.objectStore('historyMeta').get('active')) ?? 0
      if (active !== 0 && active !== 1) {
        throw new Error('Invalid history generation')
      }
      return await run(tx, active)
    } catch (error) {
      // 同步抛出的错误不会自动回滚已排入的写入。
      try {
        tx.abort()
      } catch {
        // 请求失败已经中止事务。
      }
      throw error
    }
  }
  const [result] = await Promise.all([work(), tx.done])
  return result
}

export const loadSessionSummaries = (): Promise<SessionSummary[]> =>
  transact(summaries, 'readonly', async (tx, g) =>
    (await tx.objectStore(summaries[g]).getAll()).map(toSessionSummary)
  )

export const loadSession = (id: string): Promise<Session | undefined> =>
  transact(sessions, 'readonly', (tx, g) => tx.objectStore(sessions[g]).get(id))

const deleteUnreferenced = async (tx: Tx<'readwrite'>, g: Generation, ids: string[]) => {
  const references = tx.objectStore(summaries[g]).index('fileIds')
  for (const id of ids) {
    if ((await references.count(id)) === 0) {
      await tx.objectStore(files[g]).delete(id)
    }
  }
}

export const saveSession = (
  session: Session,
  originals: StoredFile[] = [],
  removeFileIds: string[] = []
): Promise<void> =>
  transact(allData, 'readwrite', async (tx, g) => {
    for (const file of originals) {
      await tx.objectStore(files[g]).put(file)
    }
    await tx.objectStore(sessions[g]).put(session)
    await tx.objectStore(summaries[g]).put(storedSummary(session))
    await deleteUnreferenced(tx, g, removeFileIds)
  })

export const renameSession = (id: string, title: string): Promise<void> =>
  transact([...sessions, ...summaries], 'readwrite', async (tx, g) => {
    const store = tx.objectStore(sessions[g])
    const session = await store.get(id)
    if (session) {
      session.title = title
      await store.put(session)
      await tx.objectStore(summaries[g]).put(storedSummary(session))
    }
  })

export const deleteSession = (sessionId: string): Promise<void> =>
  transact(allData, 'readwrite', async (tx, g) => {
    const index = tx.objectStore(summaries[g])
    const summary = await index.get(sessionId)
    await tx.objectStore(sessions[g]).delete(sessionId)
    await index.delete(sessionId)
    await deleteUnreferenced(tx, g, summary?.fileIds ?? [])
  })

export const saveFiles = (originals: StoredFile[]): Promise<void> =>
  transact(files, 'readwrite', async (tx, g) => {
    for (const file of originals) {
      await tx.objectStore(files[g]).put(file)
    }
  })

export const loadFile = (id: string): Promise<Blob | undefined> =>
  transact(files, 'readonly', async (tx, g) => (await tx.objectStore(files[g]).get(id))?.blob)

type Staging = { writer: string; list: SessionSummary[]; withFiles: string[] }
let staging: Staging | undefined
const currentStaging = () => {
  if (!staging) {
    throw new Error('History replacement has not started')
  }
  return staging
}

// 新页面可以接管已关闭页面遗留的暂存。旧页面的下一次写入、提交、清理均受 writer 校验。
const stage = <T>(
  importState: Staging,
  stores: readonly Store[],
  run: (tx: Tx<'readwrite'>, next: Generation) => Promise<T>
) =>
  transact(stores, 'readwrite', async (tx, active) => {
    if ((await tx.objectStore('historyMeta').get('writer')) !== importState.writer) {
      throw new Error('Another page started a history replacement')
    }
    return run(tx, other(active))
  })

const KEY_BATCH = 128
/** 仅按主键分页清理非活动代；每页重新校验所有者，绝不读取原件。 */
const clearInactive = async (writer: string, release: boolean) => {
  let more: boolean
  do {
    more = await transact(allData, 'readwrite', async (tx, active) => {
      const meta = tx.objectStore('historyMeta')
      if ((await meta.get('writer')) !== writer) {
        return false
      }
      const g = other(active)
      let fullPage = false
      for (const name of [sessions[g], summaries[g], files[g]]) {
        const store = tx.objectStore(name)
        const keys = await store.getAllKeys(undefined, KEY_BATCH)
        if (keys.length) {
          await store.delete(IDBKeyRange.bound(keys[0], keys[keys.length - 1]))
        }
        fullPage ||= keys.length === KEY_BATCH
      }
      if (!fullPage && release) {
        await meta.delete('writer')
      }
      return fullPage
    })
  } while (more)
}

/** replaceHistory 的第一个调用准备暂存；同一替换失败后的第二个调用只回收本次写入。 */
export const clearStaging = async (): Promise<void> => {
  if (staging) {
    const { writer } = staging
    staging = undefined
    await clearInactive(writer, true)
    return
  }
  const writer = createId()
  await transact([], 'readwrite', (tx) => tx.objectStore('historyMeta').put(writer, 'writer'))
  await clearInactive(writer, false)
  staging = { writer, list: [], withFiles: [] }
}

export const addStagingSession = (session: Session): Promise<void> => addStagingSessions([session])

/** 导入方已经按会话字节数分组，详情和含文件引用索引的摘要在同一批写入。 */
export const addStagingSessions = async (batch: Session[]): Promise<void> => {
  const state = currentStaging()
  for (let start = 0; start < batch.length; start += 20) {
    const end = Math.min(start + 20, batch.length)
    const saved = await stage(state, [...sessions, ...summaries], async (tx, g) => {
      const rows: StoredSessionSummary[] = []
      for (let i = start; i < end; i++) {
        const session = batch[i]
        const summary = storedSummary(session)
        await tx.objectStore(sessions[g]).add(session)
        await tx.objectStore(summaries[g]).add(summary)
        rows.push(summary)
      }
      return rows
    })
    for (const summary of saved) {
      state.list.push(toSessionSummary(summary))
      if (summary.fileIds.length) {
        state.withFiles.push(summary.id)
      }
    }
  }
}

export const saveStagingFiles = async (originals: StoredFile[]): Promise<void> => {
  const state = currentStaging()
  for (let start = 0; start < originals.length; ) {
    let end = start + 1
    let bytes = originals[start].blob.size
    while (
      end < originals.length &&
      end - start < 8 &&
      bytes + originals[end].blob.size <= 16 * 1024 * 1024
    ) {
      bytes += originals[end++].blob.size
    }
    await stage(state, files, async (tx, g) => {
      for (let i = start; i < end; i++) {
        await tx.objectStore(files[g]).put(originals[i])
      }
    })
    start = end
  }
}

/** 每个含文件引用的会话单独回填 MIME，避免大文本被重新写进一个跨会话事务。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const state = currentStaging()
  for (const id of state.withFiles) {
    await stage(state, sessions, async (tx, g) => {
      const store = tx.objectStore(sessions[g])
      const session = await store.get(id)
      if (!session) {
        throw new Error('Staged session is missing')
      }
      let changed = false
      for (const message of session.messages) {
        if (message.role !== 'user') {
          continue
        }
        for (const file of message.files) {
          const type = types.get(file.id) ?? ''
          if (file.mimeType !== type) {
            file.mimeType = type
            changed = true
          }
        }
      }
      if (changed) {
        await store.put(session)
      }
    })
  }
}

/** 提交事务只写一个指针；全部详情、引用索引和原件已经持久化。 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const state = currentStaging()
  await stage(state, [], (tx, next) => tx.objectStore('historyMeta').put(next, 'active'))
  staging = undefined
  // 切换已经成功。回收失败只能留给下次准备暂存时重试，不能误报导入失败或触发草稿回滚。
  await clearInactive(state.writer, true).catch(reportStorageError('reclaim previous history'))
  return state.list
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
