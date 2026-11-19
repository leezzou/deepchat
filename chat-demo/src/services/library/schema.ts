/** Only these fields may cross the backup boundary. Never serialize settings or session objects. */
export type Folder = { id: string; name: string }
export type SessionAttributes = {
  sessionId: string
  folderId: string | null
  pinned: boolean
  memoryEnabled: boolean
}
export type Favorite = { sessionId: string; messageId: string; excerpt: string }
export type Memory = { id: string; text: string }
export type LibrarySnapshot = {
  version: 1
  folders: Folder[]
  sessions: SessionAttributes[]
  favorites: Favorite[]
  memories: Memory[]
}
export const MEMORY_LIMIT = 2000
export const emptyLibrary = (): LibrarySnapshot => ({
  version: 1,
  folders: [],
  sessions: [],
  favorites: [],
  memories: [],
})
const invalid = (): never => {
  throw new Error('Invalid library snapshot')
}
const fields = (input: unknown, expected: string[]): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid()
  }
  const proto = Object.getPrototypeOf(input)
  if (proto !== null && proto !== Object.prototype) {
    return invalid()
  }
  if (
    Object.keys(input).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(input, key))
  ) {
    return invalid()
  }
  return input as Record<string, unknown>
}
const text = (value: unknown, max: number, allowEmpty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    return invalid()
  }
  return value
}
const id = (value: unknown) => text(value, 1024)
const flag = (value: unknown) => (typeof value === 'boolean' ? value : invalid())
const rows = <T>(input: unknown, parse: (item: unknown) => T, key: (item: T) => string): T[] => {
  if (!Array.isArray(input) || input.length > 100000) {
    return invalid()
  }
  const seen = new Set<string>()
  return Array.from(input, (item) => {
    const row = parse(item)
    const unique = key(row)
    if (seen.has(unique)) {
      return invalid()
    }
    seen.add(unique)
    return row
  })
}
export const validateLibrarySnapshot = (input: unknown): LibrarySnapshot => {
  const root = fields(input, ['version', 'folders', 'sessions', 'favorites', 'memories'])
  if (root.version !== 1) {
    return invalid()
  }
  const folders = rows(
    root.folders,
    (item) => {
      const row = fields(item, ['id', 'name'])
      return { id: id(row.id), name: text(row.name, 80) }
    },
    (row) => row.id
  )
  const folderIds = new Set(folders.map((folder) => folder.id))
  const sessions = rows(
    root.sessions,
    (item) => {
      const row = fields(item, ['sessionId', 'folderId', 'pinned', 'memoryEnabled'])
      const folderId = row.folderId === null ? null : id(row.folderId)
      if (folderId !== null && !folderIds.has(folderId)) {
        return invalid()
      }
      return {
        sessionId: id(row.sessionId),
        folderId,
        pinned: flag(row.pinned),
        memoryEnabled: flag(row.memoryEnabled),
      }
    },
    (row) => row.sessionId
  )
  const favorites = rows(
    root.favorites,
    (item) => {
      const row = fields(item, ['sessionId', 'messageId', 'excerpt'])
      return {
        sessionId: id(row.sessionId),
        messageId: id(row.messageId),
        excerpt: text(row.excerpt, 240, true),
      }
    },
    (row) => JSON.stringify([row.sessionId, row.messageId])
  )
  const memories = rows(
    root.memories,
    (item) => {
      const row = fields(item, ['id', 'text'])
      return { id: id(row.id), text: text(row.text, MEMORY_LIMIT) }
    },
    (row) => row.id
  )
  return { version: 1, folders, sessions, favorites, memories }
}
