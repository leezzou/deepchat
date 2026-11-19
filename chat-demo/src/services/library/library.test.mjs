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
    { ...snapshot, version: 3 },
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

const visibleTexts = (sessionId) => lib.getVisibleMemories(sessionId).map((row) => row.text)

test('old storage and backups migrate once with the ordinary removable guide folder', async () => {
  const key = 'deepseek.local-library.v1'
  const old = {
    version: 1,
    folders: [{ id: 'work', name: 'Work' }],
    sessions: [{ sessionId: 'a', folderId: 'work', pinned: true, memoryEnabled: true }],
    favorites: [{ sessionId: 'a', messageId: 'reply', excerpt: 'saved' }],
    memories: [{ id: 'old', text: 'global preference' }],
  }
  assert.deepEqual(empty.folders, [
    { id: lib.GUIDE_FOLDER_ID, name: '示例文件夹', shareMemory: false },
  ])
  disk.set(key, JSON.stringify(old))
  const migrated = lib.exportLibrarySnapshot()
  assert.equal(migrated.version, 2)
  assert.deepEqual(migrated.folders, [{ ...old.folders[0], shareMemory: false }, ...empty.folders])
  assert.deepEqual(migrated.memories, [{ ...old.memories[0], sessionId: null }])
  assert.deepEqual(migrated.sessions, old.sessions)
  assert.deepEqual(migrated.favorites, old.favorites)
  assert.deepEqual(JSON.parse(disk.get(key)), migrated)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['global preference'])
  assert.deepEqual(lib.getSessionMemoryTexts('b'), [])
  lib.restoreLibrarySnapshot(old)
  assert.deepEqual(lib.exportLibrarySnapshot(), migrated)
  lib.updateFolder(lib.GUIDE_FOLDER_ID, 'Renamed guide', true)
  lib.deleteFolder(lib.GUIDE_FOLDER_ID)
  const reopened = await import('./index.ts?reopen')
  const after = reopened.exportLibrarySnapshot()
  assert.deepEqual(after.folders, [{ id: 'work', name: 'Work', shareMemory: false }])
  reopened.restoreLibrarySnapshot(after)
  assert.deepEqual(reopened.exportLibrarySnapshot(), after)
})

test('folder sharing follows current membership while personal and global memories remain opt-in', () => {
  const work = lib.createFolder('Work', 'a', true)
  const home = lib.createFolder('Home', 'c', true)
  lib.moveSessionToFolder('b', work)
  lib.addMemory('global')
  for (const id of ['a', 'b', 'c', 'unfiled']) {
    lib.addMemory(id, id)
  }
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['b', 'a'])
  assert.deepEqual(visibleTexts('b'), ['b', 'a', 'global'])
  assert.deepEqual(lib.getSessionMemoryTexts('unfiled'), [])
  assert.deepEqual(visibleTexts('another unfiled'), ['global'])
  lib.setMemoryEnabled('a', true)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['b', 'a', 'global'])
  lib.updateFolder(work, 'Project', false)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['a', 'global'])
  assert.deepEqual(lib.getSessionMemoryTexts('b'), [])
  assert.deepEqual(visibleTexts('b'), ['b', 'global'])
  lib.updateFolder(work, 'Project', true)
  lib.moveSessionToFolder('b', home)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['a', 'global'])
  assert.deepEqual(visibleTexts('b'), ['c', 'b', 'global'])
  lib.deleteFolder(home)
  assert.deepEqual(lib.getSessionMemoryTexts('b'), [])
  assert.deepEqual(visibleTexts('b'), ['b', 'global'])
  lib.removeLibrarySession('b')
  assert.deepEqual(visibleTexts('b'), ['global'])
  assert.deepEqual(visibleTexts('c'), ['c', 'global'])
})

test('folder drafts share from the first turn and promote their preference and folder together', () => {
  const folder = lib.createFolder('Project', 'source', true)
  lib.addMemory('source text', 'source')
  lib.addMemory('global')
  lib.setDraftFolder(folder)
  assert.equal(lib.getSessionFolderId(null), folder)
  assert.deepEqual(lib.getSessionMemoryTexts(null), ['source text'])
  lib.setMemoryEnabled(null, true)
  assert.deepEqual(lib.getSessionMemoryTexts(null), ['global', 'source text'])
  const before = lib.exportLibrarySnapshot()
  full = true
  assert.throws(() => lib.promoteLibraryDraft('created'))
  assert.deepEqual(lib.exportLibrarySnapshot(), before)
  assert.equal(lib.getSessionFolderId(null), folder)
  full = false
  lib.promoteLibraryDraft('created')
  assert.equal(lib.getSessionFolderId(null), null)
  assert.equal(lib.getSessionFolderId('created'), folder)
  assert.deepEqual(lib.getSessionMemoryTexts('created'), ['global', 'source text'])
  assert.deepEqual(lib.getSessionMemoryTexts(null), [])
  lib.setDraftFolder(folder)
  lib.deleteFolder(folder)
  lib.promoteLibraryDraft('after-delete')
  assert.deepEqual(lib.getSessionMemoryTexts('after-delete'), [])
  assert.equal(lib.getSessionFolderId('after-delete'), null)
})

test('failed shared-folder updates preserve both persisted name and permissions', () => {
  const folder = lib.createFolder('Keep', 'a', true)
  lib.addMemory('shared', 'a')
  const before = lib.exportLibrarySnapshot()
  assert.throws(() => lib.updateFolder(folder, '  ', false))
  full = true
  assert.throws(() => lib.updateFolder(folder, 'Changed', false))
  assert.deepEqual(lib.exportLibrarySnapshot(), before)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['shared'])
})
