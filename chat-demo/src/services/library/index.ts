import { createId } from '../../utils/id.js'
import {
  emptyLibrary,
  validateLibrarySnapshot,
  type LibrarySnapshot,
  type Memory,
  type SessionAttributes,
} from './schema.js'

export { validateLibrarySnapshot, MEMORY_LIMIT, GUIDE_FOLDER_ID } from './schema.js'
export type { LibrarySnapshot, Favorite, Folder, Memory, SessionAttributes } from './schema.js'

const storageKey = 'deepseek.local-library.v1'
let state = emptyLibrary()
let saved: string | null | undefined
let draftEnabled = false
let draftFolderId: string | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
const refresh = () => {
  const raw = localStorage.getItem(storageKey)
  if (raw !== saved) {
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    const next = raw === null ? emptyLibrary() : validateLibrarySnapshot(parsed)
    state = next
    saved = raw
    if (raw === null || (parsed as { version: number }).version === 1) {
      // A full disk may still be read. Writes retry validation and persistence before notifying.
      try {
        const migrated = JSON.stringify(next)
        localStorage.setItem(storageKey, migrated)
        saved = migrated
      } catch {
        /* Keep the original persisted data and its in-memory projection. */
      }
    }
  }
}
// An unreadable or future-version library must not break chat startup or be silently overwritten.
try {
  refresh()
} catch {
  /* Mutations and backup export retry and report the error. */
}
if (typeof window !== 'undefined') {
  window.addEventListener?.('storage', (event) => {
    if (event.key !== null && event.key !== storageKey) {
      return
    }
    try {
      refresh()
    } catch {
      state = emptyLibrary()
      saved = undefined
    }
    notify()
  })
}
export const subscribeLibrary = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const readLibrary = () => state
export const exportLibrarySnapshot = (): LibrarySnapshot => {
  refresh()
  return validateLibrarySnapshot(state)
}
const persist = (next: unknown) => {
  const clean = validateLibrarySnapshot(next)
  const raw = JSON.stringify(clean)
  localStorage.setItem(storageKey, raw)
  saved = raw
  state = clean
  notify()
}
export const restoreLibrarySnapshot = (snapshot: unknown) => {
  persist(snapshot)
  clearLibraryDraft()
}
const change = (mutate: (next: LibrarySnapshot) => void) => {
  const next = exportLibrarySnapshot()
  mutate(next)
  persist(next)
}
const updateAttributes = (
  sessionId: string,
  patch: Partial<Omit<SessionAttributes, 'sessionId'>>
) => {
  change((next) => {
    const current = next.sessions.find((row) => row.sessionId === sessionId)
    const row = {
      sessionId,
      folderId: null,
      pinned: false,
      memoryEnabled: false,
      ...current,
      ...patch,
    }
    next.sessions = next.sessions.filter((item) => item.sessionId !== sessionId)
    if (row.folderId !== null || row.pinned || row.memoryEnabled) {
      next.sessions.push(row)
    }
  })
}
export const createFolder = (name: string, moveSessionId?: string, shareMemory = false): string => {
  const id = createId()
  change((next) => {
    next.folders.push({ id, name: name.trim(), shareMemory })
    if (moveSessionId !== undefined) {
      const row = next.sessions.find((item) => item.sessionId === moveSessionId)
      if (row) {
        row.folderId = id
      } else {
        next.sessions.push({
          sessionId: moveSessionId,
          folderId: id,
          pinned: false,
          memoryEnabled: false,
        })
      }
    }
  })
  return id
}
const editFolder = (id: string, name: string, shareMemory?: boolean) =>
  change((next) => {
    const folder = next.folders.find((item) => item.id === id)
    if (!folder) {
      throw new Error('Missing folder')
    }
    folder.name = name.trim()
    if (shareMemory !== undefined) {
      folder.shareMemory = shareMemory
    }
  })
export const renameFolder = (id: string, name: string) => editFolder(id, name)
export const updateFolder = (id: string, name: string, shareMemory: boolean) =>
  editFolder(id, name, shareMemory)
export const deleteFolder = (id: string) =>
  change((next) => {
    next.folders = next.folders.filter((folder) => folder.id !== id)
    for (const session of next.sessions) {
      if (session.folderId === id) {
        session.folderId = null
      }
    }
    next.sessions = next.sessions.filter(
      (row) => row.folderId !== null || row.memoryEnabled || row.pinned
    )
  })
export const moveSessionToFolder = (sessionId: string, folderId: string | null) =>
  updateAttributes(sessionId, { folderId })
export const setPinned = (sessionId: string, pinned: boolean) =>
  updateAttributes(sessionId, { pinned })
export const removeLibrarySession = (sessionId: string) => {
  refresh()
  if (
    !state.sessions.some((row) => row.sessionId === sessionId) &&
    !state.favorites.some((row) => row.sessionId === sessionId) &&
    !state.memories.some((row) => row.sessionId === sessionId)
  ) {
    return
  }
  change((next) => {
    next.sessions = next.sessions.filter((row) => row.sessionId !== sessionId)
    next.favorites = next.favorites.filter((row) => row.sessionId !== sessionId)
    next.memories = next.memories.filter((row) => row.sessionId !== sessionId)
  })
}
export const isFavorite = (sessionId: string, messageId: string) =>
  state.favorites.some((row) => row.sessionId === sessionId && row.messageId === messageId)
export const removeFavorite = (sessionId: string, messageId: string) =>
  change((next) => {
    next.favorites = next.favorites.filter(
      (row) => row.sessionId !== sessionId || row.messageId !== messageId
    )
  })
export const toggleFavorite = (sessionId: string, messageId: string, excerpt: string) => {
  refresh()
  if (isFavorite(sessionId, messageId)) {
    removeFavorite(sessionId, messageId)
    return false
  }
  change((next) => {
    next.favorites.unshift({
      sessionId,
      messageId,
      excerpt: excerpt.replace(/\s+/g, ' ').trim().slice(0, 240),
    })
  })
  return true
}
export const addMemory = (text: string, sessionId: string | null = null): void =>
  change((next) => {
    next.memories.unshift({ id: createId(), text: text.trim(), sessionId })
  })
export const editMemory = (id: string, text: string) =>
  change((next) => {
    const memory = next.memories.find((row) => row.id === id)
    if (!memory) {
      throw new Error('Missing memory')
    }
    memory.text = text.trim()
  })
export const deleteMemory = (id: string) =>
  change((next) => {
    next.memories = next.memories.filter((row) => row.id !== id)
  })
export const getMemoryEnabled = (sessionId: string | null): boolean =>
  sessionId === null
    ? draftEnabled
    : state.sessions.some((row) => row.sessionId === sessionId && row.memoryEnabled)
export const setMemoryEnabled = (sessionId: string | null, memoryEnabled: boolean) => {
  if (sessionId !== null) {
    return updateAttributes(sessionId, { memoryEnabled })
  }
  draftEnabled = memoryEnabled
  state = { ...state }
  notify()
}
export const getSessionFolderId = (sessionId: string | null): string | null => {
  if (sessionId === null) {
    return state.folders.some((folder) => folder.id === draftFolderId) ? draftFolderId : null
  }
  return state.sessions.find((row) => row.sessionId === sessionId)?.folderId ?? null
}
export const setDraftFolder = (folderId: string | null) => {
  refresh()
  if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) {
    throw new Error('Missing folder')
  }
  if (folderId !== draftFolderId) {
    draftFolderId = folderId
    state = { ...state }
    notify()
  }
}
const scopedMemories = (sessionId: string | null, includePersonal: boolean): Memory[] => {
  const folderId = getSessionFolderId(sessionId)
  const shared = state.folders.some((folder) => folder.id === folderId && folder.shareMemory)
  const members = shared
    ? new Set(state.sessions.filter((row) => row.folderId === folderId).map((row) => row.sessionId))
    : undefined
  return state.memories.filter((memory) => {
    if (memory.sessionId !== null && members?.has(memory.sessionId)) {
      return true
    }
    return includePersonal && (memory.sessionId === null || memory.sessionId === sessionId)
  })
}
export const getVisibleMemories = (sessionId: string | null): Memory[] =>
  scopedMemories(sessionId, true)
export const getSessionMemoryTexts = (sessionId: string | null): string[] => {
  // Read current sharing permissions even if another tab's storage event is still queued.
  try {
    refresh()
  } catch {
    return []
  }
  return scopedMemories(sessionId, getMemoryEnabled(sessionId)).map((memory) => memory.text)
}
export const clearLibraryDraft = () => {
  if (draftEnabled || draftFolderId !== null) {
    draftEnabled = false
    draftFolderId = null
    state = { ...state }
    notify()
  }
}
export const promoteLibraryDraft = (sessionId: string) => {
  refresh()
  const folderId = getSessionFolderId(null)
  if (draftEnabled || folderId !== null) {
    updateAttributes(sessionId, {
      ...(draftEnabled ? { memoryEnabled: true } : {}),
      ...(folderId !== null ? { folderId } : {}),
    })
  }
  clearLibraryDraft()
}
