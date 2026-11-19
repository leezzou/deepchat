import { createId } from '../../utils/id.js'
import {
  emptyLibrary,
  validateLibrarySnapshot,
  type LibrarySnapshot,
  type SessionAttributes,
} from './schema.js'

export { validateLibrarySnapshot, MEMORY_LIMIT } from './schema.js'
export type { LibrarySnapshot, Favorite, Folder, Memory, SessionAttributes } from './schema.js'

const storageKey = 'deepseek.local-library.v1'
let state = emptyLibrary()
let saved: string | null | undefined
let draftEnabled = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
const refresh = () => {
  const raw = localStorage.getItem(storageKey)
  if (raw !== saved) {
    state = raw === null ? emptyLibrary() : validateLibrarySnapshot(JSON.parse(raw))
    saved = raw
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
const persist = (next: LibrarySnapshot) => {
  const clean = validateLibrarySnapshot(next)
  const raw = JSON.stringify(clean)
  localStorage.setItem(storageKey, raw)
  saved = raw
  state = clean
  notify()
}
export const restoreLibrarySnapshot = (snapshot: LibrarySnapshot) => {
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
export const createFolder = (name: string, moveSessionId?: string): string => {
  const id = createId()
  change((next) => {
    next.folders.push({ id, name: name.trim() })
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
export const renameFolder = (id: string, name: string) =>
  change((next) => {
    const folder = next.folders.find((item) => item.id === id)
    if (!folder) {
      throw new Error('Missing folder')
    }
    folder.name = name.trim()
  })
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
    !state.favorites.some((row) => row.sessionId === sessionId)
  ) {
    return
  }
  change((next) => {
    next.sessions = next.sessions.filter((row) => row.sessionId !== sessionId)
    next.favorites = next.favorites.filter((row) => row.sessionId !== sessionId)
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
export const addMemory = (text: string): void =>
  change((next) => {
    next.memories.unshift({ id: createId(), text: text.trim() })
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
export const getSessionMemoryTexts = (sessionId: string | null): string[] =>
  getMemoryEnabled(sessionId) ? state.memories.map((row) => row.text) : []
export const clearLibraryDraft = () => {
  if (draftEnabled) {
    setMemoryEnabled(null, false)
  }
}
export const promoteLibraryDraft = (sessionId: string) => {
  if (draftEnabled) {
    setMemoryEnabled(sessionId, true)
    clearLibraryDraft()
  }
}
