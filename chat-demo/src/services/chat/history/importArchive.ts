import { Capacitor } from '@capacitor/core'
import * as db from '../db.js'
import type { Session } from '../types.js'
import { parseJsonStream } from './streamJson.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  SMALL_ENTRY_BYTES,
  isZipFile,
  readArchive,
  readDirectory,
  readEntry,
  skipEntry,
  type ArchiveDirectory,
  type ArchiveEntry,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  if (entry.size > SMALL_ENTRY_BYTES) {
    try {
      return await parseJsonStream(entry.stream)
    } catch (error) {
      if (error instanceof SyntaxError) return fail('backupInvalidJson')
      throw error
    }
  }
  const decoder = new TextDecoder()
  const parts: string[] = []
  for await (const chunk of entry.stream) {
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  const text = parts.join('')
  parts.length = 0
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<ArchiveDirectory> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    const directory = await readDirectory(file)
    for await (const entry of readArchive(file, directory)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      return directory
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  return fail('backupUnrecognized')
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 会话读完立即暂存，只保留图片路径映射；图片全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
export const importArchive = async (
  file: File,
  directory: ArchiveDirectory,
  onProgress?: (processed: number, total: number) => void,
  onSession?: (session: Session) => void
): Promise<void> => {
  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  /** 图片分批写入暂存区，避免几百张图片各自开一个 IndexedDB 事务。 */
  const pendingFiles: db.StoredFile[] = []
  const pendingSessions: Session[] = []
  let pendingBytes = 0
  let sessionBytes = 0
  const flushFiles = async () => {
    if (pendingFiles.length === 0) {
      return
    }
    const batch = pendingFiles.splice(0)
    pendingBytes = 0
    await db.saveStagingFiles(batch)
  }
  const flushSessions = async () => {
    if (pendingSessions.length === 0) {
      return
    }
    sessionBytes = 0
    await db.addStagingSessions(pendingSessions.splice(0))
  }
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const owned = await readEntry(entry, Capacitor.getPlatform() === 'android')
    try {
      const type = imageType(new Uint8Array(await owned.blob.slice(0, 16).arrayBuffer()))
      const file = { id, blob: owned.blob.slice(0, owned.blob.size, type) }
      if (entry.size > SMALL_ENTRY_BYTES) {
        // Await IDB commit before releasing a temporary OPFS File, also on staging failure.
        await flushFiles()
        await db.saveStagingFiles([file])
      } else {
        pendingFiles.push(file)
        pendingBytes += file.blob.size
        if (pendingFiles.length >= 8 || pendingBytes >= 16 * 1024 * 1024) await flushFiles()
      }
      stored.set(id, type)
    } finally {
      await owned.dispose()
    }
  }

  try {
    for await (const entry of readArchive(file, directory, onProgress)) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        if (sessionBytes + entry.size > 4 * 1024 * 1024) {
          await flushSessions()
        }
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        onSession?.(local.session)
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        pendingSessions.push(local.session)
        sessionBytes += entry.size
        if (pendingSessions.length >= 20 || sessionBytes >= 4 * 1024 * 1024) {
          await flushSessions()
        }
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  await flushSessions()
  await flushFiles()
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  if (stored.size) {
    await db.updateStagingFileTypes(stored)
  }
}
