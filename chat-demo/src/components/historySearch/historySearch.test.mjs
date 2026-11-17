import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Node 22+ strips types; resolve the app's emitted .js specifiers to their TS source.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
const { searchHistory, findSearchMatches, createSearchSnippet } =
  await import('../../services/chat/search.ts')
const { keepMessageAnchored } = await import('./messageAnchor.ts')
const user = (id, content, extra = {}) => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 1000,
  ...extra,
})
const session = (id, messages, extra = {}) => ({
  id,
  title: 'Unrelated title',
  messages,
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
})
const collect = async (iterator) => {
  const batches = []
  for await (const batch of iterator) {
    batches.push(batch)
  }
  return batches
}

test('matches literal metacharacters, CJK, case and original Unicode offsets', () => {
  assert.deepEqual(findSearchMatches('a+b [x] A+B', 'a+b'), [
    [0, 3],
    [8, 11],
  ])
  assert.deepEqual(findSearchMatches('方案新的方案', '方案'), [
    [0, 2],
    [4, 6],
  ])
  assert.deepEqual(findSearchMatches('İ before TARGET', 'target'), [[9, 15]])
  assert.deepEqual(findSearchMatches('anything', '  '), [])
  const snippet = createSearchSnippet('x'.repeat(250) + ' NEEDLE ' + 'y'.repeat(250), 'needle')
  assert.equal(snippet.before, true)
  assert.equal(snippet.after, true)
  assert.match(snippet.text, /NEEDLE/)
})

test('finds hidden branch content, thoughts and attachment names without a title match', async () => {
  const data = session(
    'one',
    [
      user('root', 'Question', { parentId: null, selectedChildId: 'current' }),
      {
        id: 'current',
        role: 'assistant',
        parentId: 'root',
        blocks: [{ type: 'text', text: 'No match' }],
        createdAt: 1000,
      },
      {
        id: 'old',
        role: 'assistant',
        parentId: 'root',
        blocks: [
          { type: 'text', text: 'Needle in old answer' },
          { type: 'thinking', thinking: 'Other thought' },
        ],
        createdAt: 1000,
      },
      user('file', '', { parentId: 'old', files: [{ name: 'needle.pdf' }] }),
      {
        id: 'thought',
        role: 'assistant',
        parentId: 'file',
        blocks: [{ type: 'thinking', thinking: 'needle reasoning' }],
        createdAt: 1000,
      },
    ],
    { rootMessageId: 'root' }
  )
  const batches = await collect(
    searchHistory({
      sessions: [data],
      query: 'needle',
      signal: new AbortController().signal,
      readSession: async () => data,
    })
  )
  const results = batches.flatMap((batch) => batch.results)
  assert.deepEqual(
    results.map((result) => result.messageId),
    ['old', 'file', 'thought']
  )
  assert.ok(results.every((result) => result.alternateBranch))
})

test('yields bounded pages before reading further sessions and cancels suspended work', async () => {
  const large = session(
    'one',
    Array.from({ length: 100 }, (_, i) => user(String(i), 'needle'))
  )
  const second = session('two', [user('later', 'needle')])
  const reads = []
  const controller = new AbortController()
  const iterator = searchHistory({
    sessions: [large, second],
    query: 'needle',
    signal: controller.signal,
    readSession: async (id) => {
      reads.push(id)
      return id === 'one' ? large : second
    },
  })
  const page = await iterator.next()
  assert.equal(page.value.results.length, 40)
  assert.deepEqual(reads, ['one'])
  controller.abort()
  await assert.rejects(iterator.next(), { name: 'AbortError' })
  assert.deepEqual(reads, ['one'])
})

test('bounds batches when a title match fills the remaining page slot', async () => {
  const first = session(
    'first',
    Array.from({ length: 39 }, (_, index) => user(String(index), 'needle'))
  )
  const second = session('second', [user('body', 'needle')], { title: 'needle title' })
  const batches = await collect(
    searchHistory({
      sessions: [first, second],
      query: 'needle',
      signal: new AbortController().signal,
      readSession: async (id) => (id === 'first' ? first : second),
    })
  )
  assert.ok(batches.every((batch) => batch.results.length <= 40))
  assert.equal(batches.flatMap((batch) => batch.results).length, 41)
  assert.equal(batches[0].results.at(-1).role, 'title')
})

test('yields progress for a long nonmatching session and avoids reads for an empty query', async () => {
  const data = session(
    'long',
    Array.from({ length: 450 }, (_, index) => user(String(index), 'plain text'))
  )
  const batches = await collect(
    searchHistory({
      sessions: [data],
      query: 'missing',
      signal: new AbortController().signal,
      readSession: async () => data,
    })
  )
  assert.equal(batches.length, 3)
  assert.equal(batches.at(-1).scanned, 1)
  assert.ok(batches.every((batch) => batch.results.length === 0))
  let reads = 0
  await collect(
    searchHistory({
      sessions: [data],
      query: ' ',
      signal: new AbortController().signal,
      readSession: async () => {
        reads += 1
        return data
      },
    })
  )
  assert.equal(reads, 0)
})

test('cancels a pending storage read before publishing stale results', async () => {
  const data = session('one', [user('message', 'needle')])
  let finish
  const controller = new AbortController()
  const iterator = searchHistory({
    sessions: [data],
    query: 'needle',
    signal: controller.signal,
    readSession: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = iterator.next()
  controller.abort()
  finish(data)
  await assert.rejects(pending, { name: 'AbortError' })
})

test('continues after a failed read and reports partial failure with progress', async () => {
  const data = session('good', [user('message', 'needle')])
  const batches = await collect(
    searchHistory({
      sessions: [session('bad', []), data],
      query: 'needle',
      signal: new AbortController().signal,
      readSession: async (id) => {
        if (id === 'bad') {
          throw new Error('storage denied')
        }
        return data
      },
    })
  )
  assert.equal(batches.at(-1).failed, 1)
  assert.equal(batches.at(-1).scanned, 2)
  assert.equal(batches.flatMap((batch) => batch.results).length, 1)
})

test('corrects delayed image and layout shifts, then releases immediately on touch', () => {
  let resize
  let disconnected = false
  let frame
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resize = callback
    }
    observe() {}
    disconnect() {
      disconnected = true
    }
  }
  globalThis.requestAnimationFrame = (callback) => {
    frame = callback
    return 1
  }
  globalThis.cancelAnimationFrame = () => {
    frame = undefined
  }
  const scroll = new EventTarget()
  scroll.scrollTop = 0
  scroll.getBoundingClientRect = () => ({ top: 10 })
  const content = new EventTarget()
  const target = new EventTarget()
  let layoutTop = 600
  target.isConnected = true
  target.getBoundingClientRect = () => ({ top: layoutTop - scroll.scrollTop })
  let released = 0
  const stop = keepMessageAnchored(scroll, content, target, () => {
    released += 1
  })
  assert.equal(target.getBoundingClientRect().top, 34)
  layoutTop += 240
  resize()
  frame()
  assert.equal(target.getBoundingClientRect().top, 34)
  layoutTop += 120
  content.dispatchEvent(new Event('load'))
  frame()
  assert.equal(target.getBoundingClientRect().top, 34)
  scroll.dispatchEvent(new Event('touchstart'))
  assert.equal(released, 1)
  assert.equal(disconnected, true)
  const releasedTop = scroll.scrollTop
  layoutTop += 200
  resize()
  content.dispatchEvent(new Event('load'))
  assert.equal(frame, undefined)
  assert.equal(scroll.scrollTop, releasedTop)
  stop()
  assert.equal(released, 1)
})
