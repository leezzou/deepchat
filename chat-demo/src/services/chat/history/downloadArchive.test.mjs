// Run the Android download/reader glue without a network, WebView, or account.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { zipSync } from 'fflate'

let fixture
const modules = {
  '@capacitor/core': `export const Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    export const registerPlugin = name => ({readRange: args => globalThis.historyTest.read(name, args)});`,
  '@capacitor/filesystem': `export const Directory = { Cache: 'CACHE' };
    export const Filesystem = new Proxy({}, {get: (_, key) => (...args) => globalThis.historyTest[key](...args)});`,
  './spool.js': `export const spoolBlob = () => { throw new Error('Unexpected archive copy') };
    export const spoolIndexedDB = spoolBlob;`,
}
registerHooks({ resolve(id, ctx, next) {
  if (modules[id]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[id]), shortCircuit: true }
  if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL?.endsWith('.ts')) return next(id.slice(0, -3) + '.ts', ctx)
  return next(id, ctx)
} })
const { downloadArchive } = await import('./downloadArchive.ts')
const { isZipFile, readDirectory, readArchive, skipEntry } = await import('./zipReader.ts')
const url = 'https://example.invalid/fixture'
const zip = zipSync({ 'data.bin': new Uint8Array(900_000).fill(42) }, { level: 0 })

function setup() {
  fixture = globalThis.historyTest = {
    ranges: [], deletes: 0, removed: 0, size: zip.length, advertised: zip.length,
    addListener(event, cb) {
      assert.equal(event, 'progress')
      this.notify = cb
      return { remove: async () => { this.removed++ } }
    },
    async downloadFile(options) {
      assert.equal(options.directory, 'CACHE')
      assert.equal(options.progress, true)
      assert.match(options.path, /^history-import-[0-9a-f]{32}\.zip$/)
      this.path = options.path
      this.notify({ url, bytes: zip.length, contentLength: this.advertised })
    },
    async stat({ path }) { assert.equal(path, this.path); return { size: this.size } },
    async deleteFile({ path }) { assert.equal(path, this.path); this.deletes++ },
    read(name, { id, size, offset, length }) {
      assert.equal(name, 'HistoryArchive')
      assert.equal(`history-import-${id}.zip`, this.path)
      assert.equal(size, zip.length)
      this.ranges.push({ offset, length })
      return { data: Buffer.from(zip.subarray(offset, offset + length)).toString('base64') }
    },
  }
}

test('Android retains one cache from download through ZIP validation and disposes it once', async () => {
  setup()
  const { file, dispose } = await downloadArchive(url)
  assert.equal(fixture.removed, 1)
  assert.equal(fixture.deletes, 0)
  assert.deepEqual(fixture.ranges, []) // Confirmation does not read/copy any ZIP bytes.
  assert.ok(await isZipFile(file))
  for await (const entry of readArchive(file, await readDirectory(file))) {
    assert.equal(entry.stored, undefined)
    await skipEntry(entry) // Checks actual bytes against ZIP CRC.
  }
  assert.ok(fixture.ranges.some(r => r.offset > 262144))
  assert.equal(Math.max(...fixture.ranges.map(r => r.length)), 262144)
  await dispose(); await dispose()
  assert.equal(fixture.deletes, 1)
  await assert.rejects(file.readRange(0, 4), { name: 'NotReadableError' })
})

test('rejects incomplete/oversized downloads and clears partial files and listeners', async () => {
  for (const [size, advertised, message] of [[0, 0, /Incomplete download/], [12, 13, /Incomplete download/],
    [2 ** 31 + 1, 0, /size limit/]]) {
    setup()
    Object.assign(fixture, { size, advertised })
    await assert.rejects(downloadArchive(url), message)
    assert.equal(fixture.deletes, 1)
    assert.equal(fixture.removed, 1)
  }
  setup()
  fixture.stat = () => { throw new Error('Cache unavailable') }
  await assert.rejects(downloadArchive(url), /Cache unavailable/)
  assert.equal(fixture.deletes, 1)
  assert.equal(fixture.removed, 1)
})

test('allows unknown length, cancellation, and rejects bad ranges and short bridge replies', async () => {
  setup()
  fixture.advertised = 0
  const { file, dispose } = await downloadArchive(url)
  for (const [offset, length] of [[0, -1], [-1, 0], [file.size, 1], [0, 262145], [0.5, 1]]) {
    await assert.rejects(file.readRange(offset, length), { name: 'NotReadableError' })
  }
  assert.deepEqual(fixture.ranges, [])
  fixture.read = () => ({ data: 'YQ==' }) // Same encoded length as 3 bytes, only 1 decodes.
  await assert.rejects(file.readRange(0, 3), { name: 'NotReadableError' })
  await dispose()
  assert.equal(fixture.deletes, 1)
})

test('rejects non-HTTP(S) schemes before allocating a native cache', async () => {
  setup()
  for (const link of ['file:///private/fixture', 'data:text/plain,fixture', 'invalid/fixture']) {
    await assert.rejects(downloadArchive(link), { message: 'Invalid export link' })
  }
  assert.equal(fixture.notify, undefined)
})
