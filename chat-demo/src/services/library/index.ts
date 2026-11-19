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
const draftKey = 'deepchat:memory-draft.v1'
let draftEnabled = false
let draftFolderId: string | null = null
try {
  const raw = typeof window !== 'undefined' && window.sessionStorage?.getItem(draftKey)
  if (raw) {
    const draft = JSON.parse(raw)
    draftEnabled = draft.memoryEnabled === true
    draftFolderId = typeof draft.folderId === 'string' ? draft.folderId : null
  }
} catch {
  // Start with sharing disabled when this tab's draft is unreadable.
}
const saveDraft = (folderId: string | null, memoryEnabled: boolean) => {
  if (typeof window !== 'undefined') {
    if (folderId === null && !memoryEnabled) {
      window.sessionStorage?.removeItem(draftKey)
    } else {
      window.sessionStorage?.setItem(draftKey, JSON.stringify({ folderId, memoryEnabled }))
    }
  }
  draftFolderId = folderId
  draftEnabled = memoryEnabled
  state = { ...state }
  notify()
}
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
const refresh = () => {
  const raw = localStorage.getItem(storageKey)
  if (raw !== saved) {
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    const next = raw === null ? emptyLibrary() : validateLibrarySnapshot(parsed)
    state = next
    saved = raw
    if (raw === null || (parsed as { version: number }).version !== next.version) {
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
      chatMemoryEnabled: false,
      ...current,
      ...patch,
    }
    next.sessions = next.sessions.filter((item) => item.sessionId !== sessionId)
    if (row.folderId !== null || row.pinned || row.memoryEnabled || row.chatMemoryEnabled) {
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
          chatMemoryEnabled: false,
        })
      }
    }
  })
  return id
}
const editFolder = (id: string, name?: string, shareMemory?: boolean) =>
  change((next) => {
    const folder = next.folders.find((item) => item.id === id)
    if (!folder) {
      throw new Error('Missing folder')
    }
    if (name !== undefined) {
      folder.name = name.trim()
    }
    if (shareMemory !== undefined) {
      folder.shareMemory = shareMemory
    }
  })
export const setFolderSharing = (id: string, enabled: boolean) => editFolder(id, undefined, enabled)
export const renameFolder = (id: string, name: string) => editFolder(id, name)
export const updateFolder = (id: string, name: string, shareMemory: boolean) =>
  editFolder(id, name, shareMemory)
const folderDeletionScope = (snapshot: LibrarySnapshot, id: string) => {
  const folder = snapshot.folders.find((row) => row.id === id)
  const members = new Set(
    snapshot.sessions.filter((row) => row.folderId === id).map((row) => row.sessionId)
  )
  const memories = snapshot.memories.filter(
    (row) => row.folderId === id || (row.sessionId !== null && members.has(row.sessionId))
  )
  // Bind the confirmation to the exact data being removed, even if the counts stay the same.
  const memorySignatures = memories
    .map((row) => JSON.stringify([row.id, row.folderId, row.sessionId, row.text]))
    .sort()
  const token = JSON.stringify([id, folder?.name ?? null, [...members].sort(), memorySignatures])
  return {
    folder,
    members,
    impact: { sessionCount: members.size, memoryCount: memories.length, token },
  }
}
export const getFolderDeletionImpact = (id: string) => {
  refresh()
  return folderDeletionScope(state, id).impact
}
export const deleteFolder = (id: string, token?: string): boolean => {
  const next = exportLibrarySnapshot()
  const { folder, members, impact } = folderDeletionScope(next, id)
  if (!folder || (token !== undefined && token !== impact.token)) {
    return false
  }
  next.folders = next.folders.filter((row) => row.id !== id)
  next.memories = next.memories.filter(
    (row) => row.folderId !== id && (row.sessionId === null || !members.has(row.sessionId))
  )
  next.sessions = next.sessions.filter((row) => {
    if (row.folderId !== id) {
      return true
    }
    row.folderId = null
    return row.memoryEnabled || row.chatMemoryEnabled || row.pinned
  })
  persist(next)
  return true
}
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
export const addMemory = (
  text: string,
  sessionId: string | null = null,
  folderId: string | null = null
): void =>
  change((next) => {
    next.memories.unshift({ id: createId(), text: text.trim(), sessionId, folderId })
  })
export type MemoryScope = { kind: 'global' } | { kind: 'folder' | 'chat'; id: string }
const managedMemories = (snapshot: LibrarySnapshot, scope: MemoryScope) => {
  if (scope.kind === 'global') {
    return snapshot.memories.filter((note) => note.sessionId === null && note.folderId === null)
  }
  if (scope.kind === 'chat') {
    return snapshot.memories.filter((note) => note.sessionId === scope.id)
  }
  const shares = snapshot.folders.some((folder) => folder.id === scope.id && folder.shareMemory)
  const members = shares
    ? new Set(
        snapshot.sessions.filter((row) => row.folderId === scope.id).map((row) => row.sessionId)
      )
    : null
  return snapshot.memories.filter(
    (note) =>
      note.folderId === scope.id || (note.sessionId !== null && members?.has(note.sessionId))
  )
}
export const getManagedMemories = (scope: MemoryScope) => managedMemories(state, scope)
export const editMemory = (id: string, text: string, scope?: MemoryScope) =>
  change((next) => {
    const memory = (scope ? managedMemories(next, scope) : next.memories).find(
      (row) => row.id === id
    )
    if (!memory) {
      throw new Error('Missing memory')
    }
    memory.text = text.trim()
  })
export const deleteMemory = (id: string, scope?: MemoryScope) =>
  change((next) => {
    if (scope && !managedMemories(next, scope).some((row) => row.id === id)) {
      throw new Error('Memory no longer belongs to this scope')
    }
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
  saveDraft(draftFolderId, memoryEnabled)
}
export const setChatMemoryEnabled = (sessionId: string, chatMemoryEnabled: boolean) =>
  updateAttributes(sessionId, { chatMemoryEnabled })
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
    saveDraft(folderId, draftEnabled)
  }
}
const scopedMemories = (
  sessionId: string | null,
  includeGlobal: boolean,
  includeChat: boolean
): Memory[] => {
  const folderId = getSessionFolderId(sessionId)
  const shared = state.folders.some((folder) => folder.id === folderId && folder.shareMemory)
  const members = shared
    ? new Set(state.sessions.filter((row) => row.folderId === folderId).map((row) => row.sessionId))
    : undefined
  return state.memories.filter((memory) => {
    if (memory.folderId !== null) {
      return shared && memory.folderId === folderId
    }
    if (memory.sessionId === null) {
      return includeGlobal
    }
    if (members?.has(memory.sessionId)) {
      return true
    }
    return includeChat && memory.sessionId === sessionId
  })
}
export const getVisibleMemories = (sessionId: string | null): Memory[] =>
  scopedMemories(sessionId, true, true)
export const getSessionMemoryTexts = (sessionId: string | null): string[] => {
  // Read current sharing permissions even if another tab's storage event is still queued.
  try {
    refresh()
  } catch {
    return []
  }
  const includeChat = state.sessions.some(
    (row) => row.sessionId === sessionId && row.chatMemoryEnabled
  )
  return scopedMemories(sessionId, getMemoryEnabled(sessionId), includeChat).map(
    (memory) => memory.text
  )
}
export const clearLibraryDraft = () => {
  if (draftEnabled || draftFolderId !== null) {
    saveDraft(null, false)
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
