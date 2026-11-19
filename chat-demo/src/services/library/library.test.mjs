import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'

// Use the same native TypeScript hook as the chat tests; production modules are unchanged.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return next(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context)
    }
    return next(specifier, context)
  },
})
const disk = new Map()
let full = false
globalThis.localStorage = {
  getItem: (key) => disk.get(key) ?? null,
  setItem: (key, value) => {
    if (full) {
      throw new DOMException('Disk full', 'QuotaExceededError')
    }
    disk.set(key, value)
  },
}
const lib = await import('./index.ts')
const empty = lib.exportLibrarySnapshot()
beforeEach(() => {
  full = false
  disk.clear()
  lib.restoreLibrarySnapshot(empty)
})

test('a legacy chat needs no migration; deleting a folder preserves pin, memory and favorites', () => {
  assert.equal(lib.getMemoryEnabled('legacy'), false)
  assert.deepEqual(lib.readLibrary().sessions, [])
  const id = lib.createFolder('Project', 'legacy')
  lib.setPinned('legacy', true)
  lib.setMemoryEnabled('legacy', true)
  lib.toggleFavorite('legacy', 'reply', 'Saved')
  lib.renameFolder(id, 'Research')
  lib.deleteFolder(id)
  assert.deepEqual(lib.readLibrary().sessions, [
    { sessionId: 'legacy', folderId: null, pinned: true, memoryEnabled: true },
  ])
  assert.equal(lib.isFavorite('legacy', 'reply'), true)
  lib.removeLibrarySession('legacy')
  assert.deepEqual(lib.exportLibrarySnapshot(), empty)
})

test('memories are explicit per-chat, draft preferences move once, updates affect future context', () => {
  lib.addMemory('Preference')
  const { id } = lib.readLibrary().memories[0]
  lib.setMemoryEnabled(null, true)
  assert.deepEqual(lib.getSessionMemoryTexts(null), ['Preference'])
  assert.deepEqual(lib.exportLibrarySnapshot().sessions, [])
  lib.promoteLibraryDraft('a')
  assert.equal(lib.getMemoryEnabled(null), false)
  assert.deepEqual(lib.getSessionMemoryTexts('b'), [])
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['Preference'])
  lib.editMemory(id, 'Updated')
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['Updated'])
  lib.setMemoryEnabled('a', false)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), [])
  lib.deleteMemory(id)
  assert.deepEqual(lib.exportLibrarySnapshot(), empty)
})

test('strict backup roundtrip includes only known fields, refuses duplicates, dangling folders and credentials', () => {
  lib.addMemory('Use metric units')
  const folderId = lib.createFolder('Work')
  lib.moveSessionToFolder('__proto__', folderId)
  lib.toggleFavorite('__proto__', 'reply', 'preview')
  disk.set('secret.apiKey', 'SECRET_SENTINEL')
  const snapshot = lib.exportLibrarySnapshot()
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_SENTINEL/)
  for (const bad of [
    { ...snapshot, apiKey: 'private' },
    { ...snapshot, version: 2 },
    { ...snapshot, folders: [{ ...snapshot.folders[0], token: 'private' }] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], cookie: 'private' }] },
    { ...snapshot, favorites: [{ ...snapshot.favorites[0], credential: 'private' }] },
    { ...snapshot, memories: [{ ...snapshot.memories[0], password: 'private' }] },
    { ...snapshot, memories: [...snapshot.memories, ...snapshot.memories] },
    { ...snapshot, folders: [] },
  ]) {
    assert.throws(() => lib.restoreLibrarySnapshot(bad))
    assert.deepEqual(lib.exportLibrarySnapshot(), snapshot)
  }
  lib.restoreLibrarySnapshot(empty)
  lib.restoreLibrarySnapshot(lib.validateLibrarySnapshot(JSON.parse(JSON.stringify(snapshot))))
  assert.deepEqual(lib.exportLibrarySnapshot(), snapshot)
  snapshot.memories[0].text = 'untrusted caller changes'
  assert.equal(lib.readLibrary().memories[0].text, 'Use metric units')
})

test('failed persisted mutation leaves previous snapshot and notification count intact', () => {
  lib.addMemory('Keep')
  const before = lib.exportLibrarySnapshot()
  let updates = 0
  const stop = lib.subscribeLibrary(() => {
    updates++
  })
  full = true
  assert.throws(() => lib.addMemory('Do not save'))
  assert.throws(() => lib.restoreLibrarySnapshot(empty))
  assert.equal(updates, 0)
  assert.deepEqual(lib.exportLibrarySnapshot(), before)
  stop()
})

test('a malformed stored snapshot survives reads and attempted edits', () => {
  const key = [...disk.keys()][0]
  disk.set(key, '{invalid')
  assert.throws(() => lib.exportLibrarySnapshot())
  assert.throws(() => lib.createFolder('Lost'))
  assert.equal(disk.get(key), '{invalid')
})
