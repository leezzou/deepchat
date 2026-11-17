import { openDB, type DBSchema } from 'idb'

export type StoredDraft = {
  id: string
  sessionId: string | null
  text: string
  attachments: {
    id: string
    name: string
    type: string
    lastModified: number
    isImage: boolean
    blob: Blob
  }[]
}
export type DraftRevision = { at: number; writer: string }
export type StoredDraftRecord = StoredDraft & { revision: DraftRevision; deleted: boolean }
export type DraftJournalEntry = {
  sessionId: string | null
  text: string
  attachmentIds: string[]
  revision: DraftRevision
  deleted: boolean
}
interface DraftDB extends DBSchema {
  // Legacy rows have neither revision nor deleted; no database upgrade is necessary.
  drafts: { key: string; value: StoredDraft & Partial<Pick<StoredDraftRecord, 'revision' | 'deleted'>> }
  metadata: { key: string; value: number }
}
const LEGACY_JOURNAL_KEY = 'deepchat:draft-journal:v1'
const JOURNAL_PREFIX = 'deepchat:draft-journal:v2:'
let connection: ReturnType<typeof openDB<DraftDB>> | undefined
const getDB = () =>
  (connection ??= openDB<DraftDB>('deepchat-drafts', 1, {
    upgrade(db) {
      db.createObjectStore('drafts', { keyPath: 'id' })
      db.createObjectStore('metadata')
    },
  }).catch((error: unknown) => {
    connection = undefined
    throw error
  }))

export const draftStorageId = (sessionId: string | null) =>
  sessionId === null ? 'new' : `session:${sessionId}`

export const compareDraftRevision = (left: DraftRevision, right: DraftRevision) =>
  left.at - right.at || (left.writer < right.writer ? -1 : left.writer > right.writer ? 1 : 0)

const hasJournalText = (value: unknown): value is Omit<DraftJournalEntry, 'revision' | 'deleted'> => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const draft = value as DraftJournalEntry
  return (
    (draft.sessionId === null || typeof draft.sessionId === 'string') &&
    typeof draft.text === 'string' &&
    Array.isArray(draft.attachmentIds) &&
    draft.attachmentIds.every((id) => typeof id === 'string')
  )
}
const parseJournalEntry = (value: string | null): DraftJournalEntry | null => {
  try {
    const entry: unknown = JSON.parse(value ?? 'null')
    if (!hasJournalText(entry)) {
      return null
    }
    const draft = entry as DraftJournalEntry
    return draft.revision &&
      Number.isFinite(draft.revision.at) &&
      typeof draft.revision.writer === 'string' &&
      typeof draft.deleted === 'boolean'
      ? draft
      : null
  } catch {
    return null
  }
}
const journalKeys = () => {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith(JOURNAL_PREFIX)) {
      keys.push(key)
    }
  }
  return keys
}

/** Immutable per-edit keys cannot overwrite another tab's uncommitted journal. */
export const readDraftJournal = (): DraftJournalEntry[] => {
  const entries: DraftJournalEntry[] = []
  try {
    for (const key of journalKeys()) {
      const entry = parseJournalEntry(localStorage.getItem(key))
      if (entry) {
        entries.push(entry)
      }
    }
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_JOURNAL_KEY) ?? 'null')
    if (legacy && typeof legacy === 'object') {
      const journal = legacy as { savedAt: number; drafts: unknown[] }
      if (Number.isFinite(journal.savedAt) && Array.isArray(journal.drafts)) {
        for (const draft of journal.drafts) {
          if (hasJournalText(draft)) {
            entries.push({
              ...draft,
              revision: { at: journal.savedAt, writer: 'legacy' },
              deleted: !draft.text && draft.attachmentIds.length === 0,
            })
          }
        }
      }
    }
  } catch {
    // IndexedDB remains authoritative if the synchronous journal is unavailable.
  }
  return entries
}

export const writeDraftJournal = (entries: DraftJournalEntry[]): boolean => {
  try {
    for (const entry of entries) {
      const prefix = `${JOURNAL_PREFIX}${encodeURIComponent(draftStorageId(entry.sessionId))}:`
      const key = `${prefix}${entry.revision.at}:${entry.revision.writer}`
      localStorage.setItem(key, JSON.stringify(entry))
      // Publish before pruning, and touch only this writer's superseded immutable keys.
      // Continuous typing must not retain a complete copy for every keystroke.
      for (const olderKey of journalKeys()) {
        if (olderKey !== key && olderKey.startsWith(prefix)) {
          const older = parseJournalEntry(localStorage.getItem(olderKey))
          if (
            older?.revision.writer === entry.revision.writer &&
            compareDraftRevision(older.revision, entry.revision) < 0
          ) {
            localStorage.removeItem(olderKey)
          }
        }
      }
    }
    return true
  } catch {
    return false
  }
}

/** Read revision clocks from keys without parsing every draft's text on each keystroke. */
export const readDraftClock = () => {
  let latest = 0
  try {
    for (const key of journalKeys()) {
      const at = Number(key.slice(JOURNAL_PREFIX.length).split(':')[1])
      if (Number.isFinite(at)) {
        latest = Math.max(latest, at)
      }
    }
  } catch {
    // The local clock still advances when synchronous storage is unavailable.
  }
  return latest
}

const legacyRevision: DraftRevision = { at: 0, writer: 'legacy' }
export const readStoredDrafts = async () => {
  const tx = (await getDB()).transaction(['drafts', 'metadata'])
  const [drafts, savedAt] = await Promise.all([
    tx.objectStore('drafts').getAll(),
    tx.objectStore('metadata').get('savedAt'),
    tx.done,
  ])
  const records: StoredDraftRecord[] = drafts.map((draft) => ({
    ...draft,
    revision: draft.revision ?? legacyRevision,
    deleted: draft.deleted ?? false,
  }))
  return { records, drafts: records.filter((draft) => !draft.deleted), savedAt: savedAt ?? 0 }
}

/** Keep tombstones and compare versions in the write transaction, including stale-tab flushes. */
export const writeStoredDrafts = async (drafts: StoredDraftRecord[]) => {
  const tx = (await getDB()).transaction(['drafts', 'metadata'], 'readwrite')
  const store = tx.objectStore('drafts')
  const committed = new Map<string, StoredDraftRecord>()
  try {
    await Promise.all([
      ...drafts.map(async (draft) => {
        const previous = await store.get(draft.id)
        const revision = previous?.revision ?? legacyRevision
        const order = compareDraftRevision(draft.revision, revision)
        if (!previous || order > 0) {
          await store.put(draft)
          committed.set(draft.id, draft)
        } else {
          const value = { ...previous, revision, deleted: previous.deleted ?? false }
          if (order === 0 && !value.deleted) {
            // A recovery tab may commit the text before the original tab commits its blobs.
            // Same-revision writes can add missing originals, but must never remove them.
            const attachments = new Map(value.attachments.map((item) => [item.id, item]))
            draft.attachments.forEach((item) => attachments.set(item.id, item))
            if (attachments.size > value.attachments.length) {
              value.attachments = [...attachments.values()]
              await store.put(value)
            }
          }
          committed.set(draft.id, value)
        }
      }),
      (async () => {
        const metadata = tx.objectStore('metadata')
        const previous = (await metadata.get('savedAt')) ?? 0
        await metadata.put(Math.max(previous, ...drafts.map((draft) => draft.revision.at)), 'savedAt')
      })(),
      tx.done,
    ])
  } catch (error) {
    // Synchronous put errors do not necessarily abort IndexedDB automatically.
    try {
      tx.abort()
    } catch {
      // An asynchronous request failure may have already aborted the transaction.
    }
    await tx.done.catch(() => {})
    throw error
  }
  // Recovery of a legacy journal also publishes the committed clock for already-open tabs.
  writeDraftJournal(
    [...committed.values()].map((draft) => ({
      sessionId: draft.sessionId,
      text: draft.text,
      attachmentIds: draft.attachments.map((item) => item.id),
      revision: draft.revision,
      deleted: draft.deleted,
    }))
  )
  try {
    // Keys are immutable: a concurrent edit gets a different key and survives this cleanup.
    for (const key of journalKeys()) {
      const entry = parseJournalEntry(localStorage.getItem(key))
      const revision = entry && committed.get(draftStorageId(entry.sessionId))?.revision
      // Retain the committed head so other pages observe its logical clock before editing.
      if (entry && revision && compareDraftRevision(entry.revision, revision) < 0) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Stale journal entries are ignored by version comparison on the next hydration.
  }
}
