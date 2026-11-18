import { Inflate } from 'fflate'
import { spoolBlob, type OwnedBlob } from './spool.js'

const READ_CHUNK_BYTES = 256 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
const INFLATE_CHUNK_BYTES = 8 * 1024

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
export const isZipFile = async (file: File) => {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (start < 0 || length < 0 || start + length > file.size) {
    invalid()
  }
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (bytes.length !== length) {
    invalid()
  }
  return bytes
}

/** 流式写包器可在局部头为大小预留 64 位，即使最终目录和实际大小均为 ZIP32。 */
const safeWide = (view: DataView, at: number) => {
  const value = view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32
  return Number.isSafeInteger(value) ? value : invalid()
}

const checkExtra = (bytes: Uint8Array, required: number, disk = false, allowLocalPair = false): number[] => {
  const view = viewOf(bytes)
  const sizes: number[] = []
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      invalid()
    }
    const tag = view.getUint16(offset, true)
    const length = view.getUint16(offset + 2, true)
    offset += 4
    if (offset + length > bytes.length) {
      invalid()
    }
    if (tag === 1) {
      const words = required || (allowLocalPair ? 2 : 0)
      if (sizes.length || length === 0 || length !== words * 8 + (disk ? 4 : 0)) invalid()
      for (let i = 0; i < words; i++) sizes.push(safeWide(view, offset + i * 8))
      if (disk) sizes.push(view.getUint32(offset + words * 8, true))
    }
    offset += length
  }
  if ((required || disk) && sizes.length !== required + Number(disk)) {
    invalid()
  }
  return sizes
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

export type ArchiveDirectory = { entries: Entry[]; offset: number }

export const readDirectory = async (file: File): Promise<ArchiveDirectory> => {
  if (file.size < 22) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    invalid()
  }
  let count = tailView.getUint16(end + 10, true)
  let size = tailView.getUint32(end + 12, true)
  let offset = tailView.getUint32(end + 16, true)
  let directoryEnd = tailStart + end
  const classicDisk = tailView.getUint16(end + 4, true)
  const classicDirectoryDisk = tailView.getUint16(end + 6, true)
  const classicDiskCount = tailView.getUint16(end + 8, true)
  if (offset + size !== directoryEnd || offset === 0xffffffff || size === 0xffffffff) {
    // Single-disk ZIP64, including count-only archives of 65,536+ small files.
    const locator = viewOf(await readBytes(file, directoryEnd - 20, 20))
    if (locator.getUint32(0, true) !== 0x07064b50 || locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) invalid()
    const at = safeWide(locator, 8)
    const wide = viewOf(await readBytes(file, at, 56))
    const recordSize = safeWide(wide, 4)
    if (wide.getUint32(0, true) !== 0x06064b50 || recordSize < 44 || at + 12 + recordSize !== directoryEnd - 20 || wide.getUint32(16, true) !== 0 || wide.getUint32(20, true) !== 0) invalid()
    const value = (classic: number, sentinel: number, actual: number) => classic === sentinel || classic === actual ? actual : invalid()
    value(classicDisk, 0xffff, 0)
    value(classicDirectoryDisk, 0xffff, 0)
    count = value(count, 0xffff, safeWide(wide, 32))
    if (safeWide(wide, 24) !== count) invalid()
    value(classicDiskCount, 0xffff, count)
    size = value(size, 0xffffffff, safeWide(wide, 40))
    offset = value(offset, 0xffffffff, safeWide(wide, 48))
    directoryEnd = at
  } else if (classicDisk !== 0 || classicDirectoryDisk !== 0 || classicDiskCount !== count) {
    invalid()
  }
  if (offset + size !== directoryEnd || count > Math.floor(size / 46)) invalid()
  const entries: Entry[] = []
  const paths = new Set<string>()
  // SAF 文件每次 slice/read 都可能跨进程。顺序预读目录，避免每个条目三次小读取。
  let windowStart = -1
  let windowBytes = new Uint8Array(0)
  const directoryBytes = async (start: number, length: number) => {
    if (start < windowStart || start + length > windowStart + windowBytes.length) {
      windowStart = start
      windowBytes = await readBytes(
        file,
        offset + start,
        Math.min(size - start, Math.max(length, 64 * 1024))
      )
    }
    return windowBytes.subarray(start - windowStart, start - windowStart + length)
  }
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    const view = viewOf(await directoryBytes(cursor, 46))
    if (view.getUint32(0, true) !== 0x02014b50) {
      invalid()
    }
    const flags = view.getUint16(8, true)
    const method = view.getUint16(10, true)
    let compressedSize = view.getUint32(20, true)
    let entrySize = view.getUint32(24, true)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(32, true)
    let entryOffset = view.getUint32(42, true)
    let disk = view.getUint16(34, true)
    if (next > size) invalid()
    const required = [entrySize, compressedSize, entryOffset].filter(size => size === 0xffffffff).length
    const wide = checkExtra(await directoryBytes(cursor + 46 + nameLength, extraLength), required, disk === 0xffff)
    let field = 0
    if (entrySize === 0xffffffff) entrySize = wide[field++]
    if (compressedSize === 0xffffffff) compressedSize = wide[field++]
    if (entryOffset === 0xffffffff) entryOffset = wide[field++]
    if (disk === 0xffff) disk = wide[field]
    // 只允许 deflate 选项、data descriptor 与 UTF-8 标志。
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      (method === 0 && compressedSize !== entrySize) ||
      entryOffset >= offset ||
      disk !== 0 ||
      ((view.getUint32(38, true) >>> 16) & 0xf000) === 0xa000
    ) {
      invalid()
    }
    const name = (await directoryBytes(cursor + 46, nameLength)).slice()
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (paths.has(identity) || (path.endsWith('/') && entrySize !== 0)) {
      invalid()
    }
    paths.add(identity)
    entries.push({
      path,
      name,
      flags,
      method,
      crc: view.getUint32(16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
    })
    cursor = next
  }
  if (cursor !== size) {
    invalid()
  }
  return { entries: entries.sort((a, b) => a.offset - b.offset), offset }
}

const readEntryOffset = async (file: File, entry: Entry, boundary: number) => {
  if (entry.offset + 30 > boundary) {
    invalid()
  }
  const view = viewOf(await readBytes(file, entry.offset, 30))
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    end > boundary
  ) {
    invalid()
  }
  const metadata = await readBytes(file, entry.offset + 30, nameLength + extraLength)
  if (entry.name.some((byte, index) => byte !== metadata[index])) {
    invalid()
  }
  const size = view.getUint32(22, true)
  const compressed = view.getUint32(18, true)
  const wideCount = Number(size === 0xffffffff) + Number(compressed === 0xffffffff)
  const wide = checkExtra(metadata.subarray(nameLength), wideCount, false, true)
  // 某些写包器会同时回填普通大小和完整的 64 位大小，两份都要核对。
  if (wide.length && !wideCount && (wide[0] !== size || wide[1] !== compressed)) {
    invalid()
  }
  let index = 0
  // 局部扩展字段依次是原始大小、压缩大小。带描述符时零表示写局部头时未知。
  for (const [actual, expected] of [
    [view.getUint32(14, true), entry.crc],
    [size === 0xffffffff ? wide[index++] : size, entry.size],
    [compressed === 0xffffffff ? wide[index] : compressed, entry.compressedSize],
  ]) {
    if (actual !== expected && (!(entry.flags & 8) || actual !== 0)) {
      invalid()
    }
  }
  if (entry.flags & 8) {
    const wideDescriptor = wide.length > 0 || entry.size >= 0xffffffff || entry.compressedSize >= 0xffffffff
    const bytes = wideDescriptor ? 20 : 12
    if (end + bytes > boundary) {
      invalid()
    }
    const descriptor = viewOf(await readBytes(file, end, Math.min(bytes + 4, boundary - end)))
    const matches = (shift: number) =>
      shift + bytes <= descriptor.byteLength &&
      descriptor.getUint32(shift, true) === entry.crc &&
      (wideDescriptor
        ? descriptor.getUint32(shift + 4, true) + descriptor.getUint32(shift + 8, true) * 2 ** 32 === entry.compressedSize &&
          descriptor.getUint32(shift + 12, true) + descriptor.getUint32(shift + 16, true) * 2 ** 32 === entry.size
        : descriptor.getUint32(shift + 4, true) === entry.compressedSize && descriptor.getUint32(shift + 8, true) === entry.size)
    if (!matches(0) && !(descriptor.getUint32(0, true) === 0x08074b50 && matches(4))) {
      invalid()
    }
  }
  return start
}

export type ArchiveEntry = {
  path: string
  size: number
  /** Immutable source slice, available for STORE only. Consume stream to verify first. */
  stored?: Blob
  stream: AsyncIterable<Uint8Array>
}

/**
 * 按条目在文件中的物理顺序逐条、逐块解压，跳过目录条目。
 * 调用方必须消费完当前条目的数据，再请求下一个条目。
 */
export async function* readArchive(
  file: File,
  directory: ArchiveDirectory,
  onProgress?: (processed: number, total: number) => void
): AsyncGenerator<ArchiveEntry> {
  const total = directory.entries.reduce(
    (sum, entry) => sum + (entry.path.endsWith('/') ? 0 : entry.size),
    0
  )
  let processed = 0
  let lastProgress = 0
  const report = (bytes: number) => {
    processed += bytes
    const now = Date.now()
    if (now - lastProgress >= 100 || processed >= total) {
      lastProgress = now
      onProgress?.(Math.min(processed, total), total)
    }
  }
  onProgress?.(0, total)
  for (const [index, entry] of directory.entries.entries()) {
    const boundary = directory.entries[index + 1]?.offset ?? directory.offset
    const start = await readEntryOffset(file, entry, boundary)
    if (entry.path.endsWith('/')) {
      continue
    }
    let completed = false
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      let written = 0
      let crc = 0xffffffff
      const pending: Uint8Array[] = []
      const append = (chunk: Uint8Array) => {
        written += chunk.length
        report(chunk.length)
        if (written > entry.size) {
          invalid()
        }
        for (let i = 0; i < chunk.length; i++) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ chunk[i]) & 0xff]
        }
        if (chunk.length) {
          pending.push(chunk)
        }
      }
      const inflate = entry.method === 8 ? new Inflate(append) : null
      let lastBreath = Date.now()
      const breathe = async () => {
        const now = Date.now()
        if (now - lastBreath >= 80) {
          lastBreath = now
          // 让出一次宏任务，进度状态才能被浏览器绘制；否则大包会一直停在 0%。
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
      for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
        const chunk = await readBytes(
          file,
          start + offset,
          Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
        )
        if (!inflate) {
          append(chunk)
          yield* pending.splice(0)
          await breathe()
          continue
        }
        for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
          const end = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
          inflate.push(chunk.subarray(cursor, end), offset + end === entry.compressedSize)
          // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
          yield* pending.splice(0)
          await breathe()
        }
      }
      if (inflate && entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true)
        yield* pending.splice(0)
      }
      if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
        invalid()
      }
      completed = true
    }
    yield { path: entry.path, size: entry.size, stored: entry.method === 0 ? file.slice(start, start + entry.size) : undefined, stream: stream() }
    if (!completed) {
      invalid()
    }
  }
  onProgress?.(total, total)
}

// Small deflated entries may share an IDB batch. Larger entries use a dedicated disk spool.
export const SMALL_ENTRY_BYTES = 1024 * 1024
export const readEntry = async (entry: ArchiveEntry, copyPickerBytes = false): Promise<OwnedBlob> => {
  // Android document-provider slices are readable but cannot be serialized to IndexedDB
  // on some WebViews (UnknownError: Failed to write blobs). Persist app-owned bytes there.
  if (entry.stored && !copyPickerBytes) {
    await skipEntry(entry)
    return { blob: entry.stored, dispose: async () => {} }
  }
  const memoryBudget = copyPickerBytes && entry.stored ? 8 * 1024 * 1024 : SMALL_ENTRY_BYTES
  if (entry.size > memoryBudget) return spoolBlob(entry.stream)
  const parts: BlobPart[] = []
  for await (const chunk of entry.stream) parts.push(chunk as Uint8Array<ArrayBuffer>)
  return { blob: new Blob(parts), dispose: async () => {} }
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}
