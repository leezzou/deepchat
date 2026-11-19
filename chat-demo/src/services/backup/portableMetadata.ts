import { openDB, type DBSchema } from 'idb'
import {
  exportConversationModes,
  importConversationModes,
  validateConversationModes,
} from '../conversationMode/storage.js'
import {
  exportLibrarySnapshot,
  restoreLibrarySnapshot,
  validateLibrarySnapshot,
} from '../library/index.js'
import { readLastRestoreId, setStagingRestoreId } from '../chat/db.js'
import { createId } from '../../utils/id.js'
import type { StoredDraft } from '../chat/draftStorage.js'
import { PortableError } from './portableCrypto.js'

export function capturePortableMetadata(sessionIds: readonly string[]) {
  const library = exportLibrarySnapshot()
  const active = new Set(sessionIds)
  library.sessions = library.sessions.filter((row) => active.has(row.sessionId))
  library.favorites = library.favorites.filter((row) => active.has(row.sessionId))
  library.memories = library.memories.filter(
    (row) => row.sessionId === null || active.has(row.sessionId)
  )
  return { version: 1 as const, library, modes: exportConversationModes(sessionIds) }
}
export type PortableMetadata = ReturnType<typeof capturePortableMetadata>
export function validatePortableMetadata(
  value: unknown,
  sessionIds: readonly string[]
): PortableMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PortableError('format')
  }
  const item = value as Record<string, unknown>
  if (
    item.version !== 1 ||
    Object.keys(item).some((key) => !['version', 'library', 'modes'].includes(key))
  ) {
    throw new PortableError('format')
  }
  try {
    const library = validateLibrarySnapshot(item.library)
    const ids = new Set(sessionIds)
    if (
      [...library.sessions, ...library.favorites].some((row) => !ids.has(row.sessionId)) ||
      library.memories.some((row) => row.sessionId !== null && !ids.has(row.sessionId))
    ) {
      throw new PortableError('format')
    }
    return { version: 1, library, modes: validateConversationModes(item.modes, sessionIds) }
  } catch {
    throw new PortableError('format')
  }
}
interface JournalDB extends DBSchema {
  journal: {
    key: 'pending'
    value: { id: string; previous: PortableMetadata; ids: string[]; drafts: StoredDraft[] }
  }
}
const journal = () =>
  openDB<JournalDB>('deepchat-portable-recovery', 1, {
    upgrade(db) {
      db.createObjectStore('journal')
    },
  })
const apply = (metadata: PortableMetadata, ids: readonly string[]) => {
  importConversationModes(metadata.modes, ids)
  restoreLibrarySnapshot(metadata.library)
}
// Hold the cross-page lock from journal creation through the durable generation flip.
// The normal startup path takes the same lock, before any editable UI is mounted.
export async function withPortableLock<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    throw new PortableError('unavailable')
  }
  return navigator.locks.request('deepchat-portable-restore', run)
}
async function reconcile() {
  const db = await journal()
  try {
    const pending = await db.get('journal', 'pending')
    if (!pending) {
      return
    }
    if ((await readLastRestoreId()) !== pending.id) {
      apply(validatePortableMetadata(pending.previous, pending.ids), pending.ids)
    } else {
      // Drafts live in a different database. Replay the desired set until it is durable,
      // including when the process died immediately after the generation switch.
      const { restoreDrafts } = await import('../chat/drafts.js')
      await restoreDrafts(pending.drafts)
    }
    await db.delete('journal', 'pending')
  } finally {
    db.close()
  }
}
export async function recoverPortableRestore() {
  // Browsers without Web Locks cannot start portable restores. An older browser may
  // still open an existing profile after downgrade, so check for a pending record.
  if (!navigator.locks) {
    const db = await journal()
    try {
      if (await db.count('journal')) {
        throw new PortableError('unavailable')
      }
    } finally {
      db.close()
    }
    return
  }
  await withPortableLock(reconcile)
}
/** Called inside replaceHistory's staging callback, after validation and safety snapshot. */
export async function stagePortableMetadata(
  next: PortableMetadata,
  targetIds: string[],
  previousIds: string[],
  drafts: StoredDraft[] = []
) {
  const previous = capturePortableMetadata(previousIds)
  const id = createId()
  const db = await journal()
  try {
    await db.add('journal', { id, ids: previousIds, previous, drafts }, 'pending')
  } finally {
    db.close()
  }
  setStagingRestoreId(id)
  apply(next, targetIds)
}
export async function withMetadataRecovery<T>(run: () => Promise<T>): Promise<T> {
  return withPortableLock(async () => {
    await reconcile()
    try {
      return await run()
    } finally {
      await reconcile()
    }
  })
}
