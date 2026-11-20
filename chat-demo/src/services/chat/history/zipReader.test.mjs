import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync } from 'fflate'
import { registerHooks } from 'node:module'
registerHooks({ resolve(id, ctx, next) {
  if (['./spool.js', './archiveSource.js'].includes(id) && ctx.parentURL?.endsWith('/zipReader.ts')) return next(id.replace('.js', '.ts'), ctx)
  return next(id, ctx)
} })
const { ArchiveError, readArchive, readDirectory, readEntry } = await import('./zipReader.ts')

// Single STORE entry with a conventional ZIP32 directory and streaming local header.
function fixture({ placeholder = false, descriptor = false, mismatch, signature = true } = {}) {
  const data = new TextEncoder().encode('多字节正文🙂')
  const plain = Buffer.from(zipSync({ 'text.txt': data }, { level: 0 }))
  const nameEnd = 30 + plain.readUInt16LE(26)
  const directoryOffset = plain.readUInt32LE(plain.length - 6)
  const local = Buffer.from(plain.subarray(0, nameEnd))
  const crc = local.readUInt32LE(14)
  const directory = Buffer.from(plain.subarray(directoryOffset))
  const extra = Buffer.alloc(20)
  extra.writeUInt16LE(1)
  extra.writeUInt16LE(16, 2)
  const size = descriptor ? 0 : data.length
  extra.writeUInt32LE(size, 4)
  extra.writeUInt32LE(size, 12)
  local.writeUInt16LE(extra.length, 28)
  local.writeUInt32LE(placeholder ? 0xffffffff : size, 18)
  local.writeUInt32LE(placeholder ? 0xffffffff : size, 22)
  let trailer = Buffer.alloc(0)
  if (descriptor) {
    local.writeUInt16LE(local.readUInt16LE(6) | 8, 6)
    local.writeUInt32LE(0, 14)
    directory.writeUInt16LE(directory.readUInt16LE(8) | 8, 8)
    const shift = signature ? 4 : 0
    trailer = Buffer.alloc(20 + shift)
    if (signature) {
      trailer.writeUInt32LE(0x08074b50)
    }
    trailer.writeUInt32LE(crc, shift)
    trailer.writeUInt32LE(data.length, shift + 4)
    trailer.writeUInt32LE(data.length, shift + 12)
    if (mismatch === 'descriptor') {
      trailer.writeUInt32LE(1, shift + 16)
    }
  }
  if (mismatch === 'size') {
    extra.writeUInt32LE(size + 1, 4)
  }
  if (mismatch === 'high') {
    extra.writeUInt32LE(1, 8)
  }
  directory.writeUInt32LE(directoryOffset + extra.length + trailer.length, directory.length - 6)
  return new File([local, extra, data, trailer, directory], 'stream.zip')
}
async function read(file) {
  const result = []
  for await (const entry of readArchive(file, await readDirectory(file))) {
    const owned = await readEntry(entry)
    try { result.push(await owned.blob.text()) } finally { await owned.dispose() }
  }
  return result
}
for (const placeholder of [false, true]) {
  for (const options of [
    {},
    { descriptor: true, signature: true },
    { descriptor: true, signature: false },
  ]) {
    test(`reads local wide sizes ${JSON.stringify({ placeholder, ...options })}`, async () => {
      assert.deepEqual(await read(fixture({ placeholder, ...options })), ['多字节正文🙂'])
    })
  }
}
test('STORE returns the source slice only after verifying all payload bytes, and rejects bad CRC', async () => {
  const payload = new Uint8Array(900_000).fill(121)
  const bytes = zipSync({ 'photo.bin': payload }, { level: 0 })
  const readAttachment = async () => {
    const file = new File([bytes], 'images.zip')
    for await (const entry of readArchive(file, await readDirectory(file))) {
      const owned = await readEntry(entry)
      assert.equal(owned.blob, entry.stored)
      assert.equal(owned.blob.size, payload.length)
      assert.equal((await owned.blob.slice(-1).bytes())[0], 121)
      await owned.dispose()
    }
  }
  await readAttachment()
  bytes[1000]++
  await assert.rejects(readAttachment, ArchiveError)
})

test('Android picker STORE attachments persist owned bytes instead of provider-backed slices', async () => {
  const file = fixture()
  for await (const entry of readArchive(file, await readDirectory(file))) {
    const owned = await readEntry(entry, true)
    assert.notEqual(owned.blob, entry.stored)
    assert.equal(await owned.blob.text(), '多字节正文🙂')
    await owned.dispose()
  }
})

test('parses ZIP64 count-only EOCD for 65,536 entries and validates conflicting wide offsets', async () => {
  const count = 2 ** 16
  // Directory entries alone suffice to verify the listing path. Each local header has a 4-byte name.
  const local = Buffer.alloc(count * 34)
  const directory = Buffer.alloc(count * 50)
  const wide = Buffer.alloc(56)
  const locator = Buffer.alloc(20)
  const end = Buffer.alloc(22)
  for (let i = 0; i < count; i++) {
    const name = i.toString(16).padStart(4, '0')
    local.writeUInt32LE(0x04034b50, i * 34)
    local.writeUInt16LE(4, i * 34 + 26)
    local.write(name, i * 34 + 30)
    directory.writeUInt32LE(0x02014b50, i * 50)
    directory.writeUInt16LE(4, i * 50 + 28)
    directory.writeUInt32LE(i * 34, i * 50 + 42)
    directory.write(name, i * 50 + 46)
  }
  wide.writeUInt32LE(0x06064b50)
  wide.writeBigUInt64LE(44n, 4)
  wide.writeBigUInt64LE(BigInt(count), 24)
  wide.writeBigUInt64LE(BigInt(count), 32)
  wide.writeBigUInt64LE(BigInt(directory.length), 40)
  wide.writeBigUInt64LE(BigInt(local.length), 48)
  locator.writeUInt32LE(0x07064b50)
  locator.writeBigUInt64LE(BigInt(local.length + directory.length), 8)
  locator.writeUInt32LE(1, 16)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(local.length, 16)
  const file = () => new File([local, directory, wide, locator, end], 'many.zip')
  const parsed = await readDirectory(file())
  assert.equal(parsed.entries.length, count)
  assert.equal(parsed.entries.at(-1).path, 'ffff')
  wide.writeUInt32LE(1, 52)
  await assert.rejects(readDirectory(file()), ArchiveError)
})

for (const mismatch of ['size', 'high', 'descriptor']) {
  test(`rejects inconsistent local ${mismatch}`, async () => {
    await assert.rejects(
      read(fixture({ mismatch, descriptor: mismatch === 'descriptor' })),
      ArchiveError
    )
  })
}
