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
    {
      sessionId: 'legacy',
      folderId: null,
      pinned: true,
      memoryEnabled: true,
      chatMemoryEnabled: false,
    },
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
    { ...snapshot, version: 4 },
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
  assert.equal(migrated.version, 3)
  assert.deepEqual(migrated.folders, [{ ...old.folders[0], shareMemory: false }, ...empty.folders])
  assert.deepEqual(migrated.memories, [{ ...old.memories[0], sessionId: null, folderId: null }])
  assert.deepEqual(migrated.sessions, [{ ...old.sessions[0], chatMemoryEnabled: true }])
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
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['global'])
  lib.setChatMemoryEnabled('a', true)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['a', 'global'])
  assert.deepEqual(lib.getSessionMemoryTexts('b'), [])
  assert.deepEqual(visibleTexts('b'), ['b', 'global'])
  lib.updateFolder(work, 'Project', true)
  lib.moveSessionToFolder('b', home)
  assert.deepEqual(lib.getSessionMemoryTexts('a'), ['a', 'global'])
  assert.deepEqual(visibleTexts('b'), ['c', 'b', 'global'])
  lib.deleteFolder(home)
  assert.deepEqual(lib.getSessionMemoryTexts('b'), [])
  assert.deepEqual(visibleTexts('b'), ['global'])
  assert.deepEqual(visibleTexts('c'), ['global'])
  // Individual chat deletion also clears a memory created while ungrouped.
  lib.addMemory('ungrouped later', 'b')
  lib.removeLibrarySession('b')
  assert.deepEqual(visibleTexts('b'), ['global'])
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

for (const sharing of [false, true]) {
  test(`folder deletion removes only current members' memories (sharing=${sharing})`, () => {
    const folder = lib.createFolder('Remove', 'a', sharing)
    const other = lib.createFolder('Keep', 'moved')
    lib.moveSessionToFolder('moved', folder)
    lib.addMemory('owned before moving', 'moved')
    lib.moveSessionToFolder('moved', other)
    lib.moveSessionToFolder('b', folder)
    lib.addMemory('global')
    lib.addMemory('unfiled', 'u')
    lib.addMemory('private a', 'a')
    lib.addMemory('private b', 'b')
    lib.addMemory('another a', 'a')
    lib.setPinned('a', true)
    lib.setMemoryEnabled('b', true)
    lib.toggleFavorite('b', 'reply', 'keep favorite')
    const { sessionCount, memoryCount, token } = lib.getFolderDeletionImpact(folder)
    assert.deepEqual([sessionCount, memoryCount], [2, 3])
    lib.addMemory('out of scope', 'another')
    assert.equal(lib.deleteFolder(folder, token), true)
    assert.deepEqual(
      lib.exportLibrarySnapshot().memories.map((row) => row.text),
      ['out of scope', 'unfiled', 'global', 'owned before moving']
    )
    assert.equal(lib.getSessionFolderId('a'), null)
    assert.equal(lib.getSessionFolderId('b'), null)
    assert.equal(lib.readLibrary().sessions.find((row) => row.sessionId === 'a').pinned, true)
    assert.equal(lib.getMemoryEnabled('b'), true)
    assert.equal(lib.isFavorite('b', 'reply'), true)
    assert.equal(lib.getSessionFolderId('moved'), other)
    assert.equal(lib.deleteFolder(folder, token), false)
  })
}

test('equal counts with replaced members or memories and an edited memory require fresh confirmation', () => {
  const folder = lib.createFolder('Test', 'a', true)
  lib.addMemory('same text', 'a')
  lib.addMemory('same text', 'b')
  const initial = lib.getFolderDeletionImpact(folder)
  lib.moveSessionToFolder('a', null)
  lib.moveSessionToFolder('b', folder)
  const differentMembers = lib.getFolderDeletionImpact(folder)
  assert.equal(initial.sessionCount, differentMembers.sessionCount)
  assert.equal(initial.memoryCount, differentMembers.memoryCount)
  assert.equal(lib.deleteFolder(folder, initial.token), false)
  lib.deleteMemory(lib.getVisibleMemories('b')[0].id)
  lib.addMemory('same text', 'b')
  assert.equal(lib.deleteFolder(folder, differentMembers.token), false)
  const replaced = lib.getFolderDeletionImpact(folder)
  lib.editMemory(lib.getVisibleMemories('b')[0].id, 'edited during confirmation')
  // A remote tab can write before its storage event arrives in this window.
  const key = 'deepseek.local-library.v1'
  const edited = JSON.parse(disk.get(key))
  edited.memories[0].text = 'most recent edit'
  disk.set(key, JSON.stringify(edited))
  assert.equal(lib.deleteFolder(folder, replaced.token), false)
  assert.deepEqual(lib.exportLibrarySnapshot(), edited)
  assert.equal(lib.deleteFolder(folder, lib.getFolderDeletionImpact(folder).token), true)
  assert.deepEqual(visibleTexts('a'), ['same text'])
})

test('folder deletion commits once and can retry after a failed storage write', () => {
  const folder = lib.createFolder('Remove', 'member')
  lib.addMemory('keep until committed', 'member')
  lib.setDraftFolder(folder)
  const { token } = lib.getFolderDeletionImpact(folder)
  const before = lib.exportLibrarySnapshot()
  let notifications = 0
  const stop = lib.subscribeLibrary(() => {
    notifications++
  })
  try {
    full = true
    assert.throws(() => lib.deleteFolder(folder, token), { name: 'QuotaExceededError' })
    assert.equal(notifications, 0)
    assert.deepEqual(lib.readLibrary(), before)
    assert.deepEqual(JSON.parse(disk.get('deepseek.local-library.v1')), before)
    assert.equal(lib.getSessionFolderId(null), folder)
    full = false
    assert.equal(lib.deleteFolder(folder, token), true)
    assert.equal(notifications, 1)
    assert.equal(lib.getSessionFolderId(null), null)
    assert.deepEqual(lib.exportLibrarySnapshot(), empty)
  } finally {
    stop()
  }
})

test('v2 migration keeps private and global consent; changing either one stays independent after reload', async () => {
  const key = 'deepseek.local-library.v1'
  disk.set(
    key,
    JSON.stringify({
      version: 2,
      folders: [],
      favorites: [],
      sessions: [{ sessionId: 'on', folderId: null, pinned: false, memoryEnabled: true }],
      memories: [
        { id: 'm1', text: 'personal', sessionId: 'on' },
        { id: 'm2', text: 'global', sessionId: null },
        { id: 'm3', text: 'old private', sessionId: 'off' },
      ],
    })
  )
  assert.deepEqual(lib.getSessionMemoryTexts('on'), ['personal', 'global'])
  assert.deepEqual(lib.getSessionMemoryTexts('off'), [])
  lib.setMemoryEnabled('on', false)
  lib.setMemoryEnabled('off', true)
  const reopened = await import('./index.ts?reopen-v3')
  assert.deepEqual(reopened.getSessionMemoryTexts('on'), ['personal'])
  assert.deepEqual(reopened.getSessionMemoryTexts('off'), ['global'])
  assert.deepEqual(
    reopened.getManagedMemories({ kind: 'global' }).map((m) => m.text),
    ['global']
  )
  assert.equal(JSON.parse(disk.get(key)).version, 3)
})

test('an empty folder can own notes, stale managers cannot edit moved notes, deletion stays bounded', () => {
  const folder = lib.createFolder('Notes')
  const other = lib.createFolder('Other')
  const scope = { kind: 'folder', id: folder }
  lib.addMemory('global')
  lib.addMemory('other', null, other)
  lib.addMemory('folder', null, folder)
  const [owned] = lib.getManagedMemories(scope)
  assert.equal(owned.text, 'folder')
  assert.throws(() => lib.editMemory(owned.id, 'cross-scope', { kind: 'global' }))
  assert.throws(() => lib.deleteMemory(owned.id, { kind: 'folder', id: other }))
  assert.throws(() => lib.addMemory('ambiguous', 'chat', folder))
  assert.throws(() => lib.addMemory('orphan', null, 'missing'))
  lib.editMemory(owned.id, 'edited folder', scope)
  lib.setDraftFolder(folder)
  assert.deepEqual(lib.getSessionMemoryTexts(null), [])
  lib.setFolderSharing(folder, true)
  assert.deepEqual(lib.getSessionMemoryTexts(null), ['edited folder'])
  lib.moveSessionToFolder('member', folder)
  lib.addMemory('member note', 'member')
  const [member] = lib.getManagedMemories(scope)
  assert.equal(member.text, 'member note')
  const before = lib.getFolderDeletionImpact(folder)
  assert.equal(before.memoryCount, 2)
  lib.moveSessionToFolder('member', other)
  assert.throws(() => lib.editMemory(member.id, 'moved', scope))
  assert.equal(lib.deleteFolder(folder, before.token), false)
  assert.equal(lib.deleteFolder(folder, lib.getFolderDeletionImpact(folder).token), true)
  assert.deepEqual(
    lib.exportLibrarySnapshot().memories.map((m) => m.text),
    ['member note', 'other', 'global']
  )
})

test('welcome memory settings belong to this tab, survive a reload, and promote only once', async () => {
  const tab = new Map()
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => tab.get(key) ?? null,
      setItem: (key, value) => tab.set(key, value),
      removeItem: (key) => tab.delete(key),
    },
  }
  try {
    const folder = lib.createFolder('Folder', undefined, true)
    lib.addMemory('general')
    lib.addMemory('in folder', null, folder)
    lib.setDraftFolder(folder)
    lib.setMemoryEnabled(null, true)
    const reload = await import('./index.ts?reopen-draft')
    assert.deepEqual(reload.getSessionMemoryTexts(null), ['in folder', 'general'])
    reload.promoteLibraryDraft('created')
    const next = await import('./index.ts?reopen-consumed')
    assert.deepEqual(next.getSessionMemoryTexts('created'), ['in folder', 'general'])
    assert.deepEqual(next.getSessionMemoryTexts(null), [])
    assert.equal(tab.size, 0)
  } finally {
    delete globalThis.window
  }
})
