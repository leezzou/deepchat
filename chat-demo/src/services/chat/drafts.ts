import type { ChatAccess } from '../api/access.js'
import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  isImage,
  resolveMimeType,
  uploadAttachment,
  useUploads,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'
import {
  compareDraftRevision,
  draftStorageId,
  readDraftJournal,
  readDraftClock,
  readStoredDrafts,
  writeDraftJournal,
  writeStoredDrafts,
  type StoredDraft,
  type StoredDraftRecord,
} from './draftStorage.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

export type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 草稿与聊天分开持久化；附件原件存 IndexedDB，文字另有同步恢复日志。 */
export const useDrafts = create<{
  drafts: Map<string | null, Draft>
  ready: boolean
  saving: boolean
  saveError: boolean
  recoveryWarning: boolean
}>(() => ({
  drafts: new Map(),
  ready: false,
  saving: false,
  saveError: false,
  recoveryWarning: false,
}))

let initializing: Promise<void> | undefined
let restoring = false
let revisionAt = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined
const writer = createId()
const dirtyRecords = new Map<string, StoredDraftRecord>()
let saving: Promise<boolean> | undefined

const storedDrafts = (): StoredDraft[] =>
  [...useDrafts.getState().drafts].map(([sessionId, draft]) => ({
    id: draftStorageId(sessionId),
    sessionId,
    text: draft.text,
    attachments: draft.attachments.map((item) => ({
      id: item.id,
      name: item.file.name,
      type: item.file.type,
      lastModified: item.file.lastModified,
      isImage: item.isImage,
      blob: item.file,
    })),
  }))

const saveJournal = () =>
  writeDraftJournal(
    [...dirtyRecords.values()].map((draft) => ({
      sessionId: draft.sessionId,
      text: draft.text,
      attachmentIds: draft.attachments.map((item) => item.id),
      revision: draft.revision,
      deleted: draft.deleted,
    }))
  )

/** Await this before an application-controlled refresh or installer launch. */
export const flushDrafts = (): Promise<boolean> => {
  clearTimeout(saveTimer)
  if (saving) {
    return saving
  }
  saving = (async () => {
    if (!useDrafts.getState().ready) {
      await initDrafts()
    }
    if (!useDrafts.getState().ready) {
      return false
    }
    useDrafts.setState({ saving: true })
    try {
      while (dirtyRecords.size > 0) {
        const records = [...dirtyRecords.values()]
        dirtyRecords.clear()
        try {
          await writeStoredDrafts(records)
        } catch {
          for (const record of records) {
            const newer = dirtyRecords.get(record.id)
            if (!newer || compareDraftRevision(newer.revision, record.revision) < 0) {
              dirtyRecords.set(record.id, record)
            }
          }
          useDrafts.setState({ saveError: true })
          return false
        }
      }
      useDrafts.setState({ saveError: false })
      return true
    } finally {
      useDrafts.setState({ saving: false })
    }
  })().finally(() => {
    saving = undefined
  })
  return saving
}

export const initDrafts = (): Promise<void> =>
  (initializing ??= (async () => {
    restoring = true
    const journal = readDraftJournal()
    let stored: Awaited<ReturnType<typeof readStoredDrafts>> = {
      drafts: [],
      records: [],
      savedAt: 0,
    }
    try {
      stored = await readStoredDrafts()
    } catch {
      restoring = false
      useDrafts.setState({ saveError: true })
      return
    }
    const drafts = new Map<string | null, Draft>()
    const disk = new Map(stored.records.map((draft) => [draft.id, draft]))
    const latest = new Map<string, (typeof journal)[number]>()
    for (const entry of journal) {
      // A v1 snapshot cannot tell an intentional deletion from an absent tab's draft.
      // Migrate its explicit entries only; never delete rows missing from that snapshot.
      if (entry.revision.writer === 'legacy' && entry.revision.at <= stored.savedAt) {
        continue
      }
      const id = draftStorageId(entry.sessionId)
      const previous = latest.get(id) ?? disk.get(id)
      if (!previous || compareDraftRevision(entry.revision, previous.revision) > 0) {
        latest.set(id, entry)
      }
    }
    let missingAttachment = false
    for (const [id, entry] of latest) {
      const attachments = entry.attachmentIds.flatMap((attachmentId) => {
        const item = disk.get(id)?.attachments.find((attachment) => attachment.id === attachmentId)
        if (!item || !(item.blob instanceof Blob)) {
          missingAttachment = true
          return []
        }
        return [item]
      })
      const record: StoredDraftRecord = {
        id,
        sessionId: entry.sessionId,
        text: entry.text,
        attachments,
        revision: entry.revision,
        deleted: entry.deleted,
      }
      disk.set(id, record)
      dirtyRecords.set(id, record)
    }
    const restoredTasks: Record<string, UploadTask> = {}
    for (const record of disk.values()) {
      if (record.deleted) {
        continue
      }
      const attachments: DraftAttachment[] = []
      for (const item of record.attachments) {
        if (!(item.blob instanceof Blob)) {
          missingAttachment = true
          continue
        }
        const file = new File([item.blob], item.name, {
          type: item.type,
          lastModified: item.lastModified,
        })
        attachments.push({
          id: item.id,
          file,
          isImage: item.isImage,
          previewUrl: item.isImage ? URL.createObjectURL(file) : null,
        })
        // Never silently upload recovered files to a possibly changed API account.
        restoredTasks[item.id] = {
          status: 'error',
          retryable: true,
          error: { key: 'draftAttachmentRestored' },
        }
      }
      if (record.text || attachments.length) {
        drafts.set(record.sessionId, { text: record.text, attachments })
      }
    }
    revisionAt = Math.max(stored.savedAt, ...[...disk.values()].map((draft) => draft.revision.at))
    useUploads.setState((state) => ({ tasks: { ...state.tasks, ...restoredTasks } }))
    useDrafts.setState({
      drafts,
      ready: true,
      saveError: false,
      recoveryWarning: missingAttachment,
    })
    restoring = false
    if (dirtyRecords.size > 0) {
      // Recovery writes are scheduled after hydration so updates cannot deadlock waiting for it.
      saveTimer = setTimeout(() => {
        void flushDrafts()
      }, 0)
    }
  })().finally(() => {
    if (!useDrafts.getState().ready) {
      initializing = undefined
    }
  }))

useDrafts.subscribe((state, previous) => {
  if (restoring || state.drafts === previous.drafts) {
    return
  }
  revisionAt = Math.max(Date.now(), revisionAt + 1, readDraftClock() + 1)
  const records = new Map(storedDrafts().map((draft) => [draft.id, draft]))
  for (const key of new Set([...state.drafts.keys(), ...previous.drafts.keys()])) {
    if (state.drafts.get(key) !== previous.drafts.get(key)) {
      const id = draftStorageId(key)
      dirtyRecords.set(id, {
        ...(records.get(id) ?? { id, sessionId: key, text: '', attachments: [] }),
        revision: { at: revisionAt, writer },
        deleted: !state.drafts.has(key),
      })
    }
  }
  if (!saveJournal()) {
    useDrafts.setState({ saveError: true })
  }
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void flushDrafts()
  }, 250)
})

export const bindDraftPersistence = () => {
  const flush = () => {
    if (!useDrafts.getState().ready) {
      return
    }
    saveJournal()
    void flushDrafts()
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  }
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('pagehide', flush)
    document.removeEventListener('visibilitychange', onVisibility)
    flush()
  }
}

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, access: ChatAccess) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    access,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage
  ).catch(() => {})
}

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  access: ChatAccess
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.map((item) => item.file), access)
  if (error) {
    return error
  }
  const added = files.map((file): DraftAttachment => {
    const image = isImage(resolveMimeType(file))
    return {
      id: createId(),
      file,
      isImage: image,
      previewUrl: image ? URL.createObjectURL(file) : null,
    }
  })
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(attachment, access))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  access: ChatAccess
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(attachment, access)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

const releaseAttachment = (attachment: DraftAttachment, cancel: boolean) => {
  if (cancel) {
    cancelUpload(attachment.id)
  }
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  releaseAttachment(attachment, true)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，释放预览但保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, false))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, true))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => releaseAttachment(attachment, true))
  }
  useDrafts.setState({ drafts: new Map() })
}

/** Local recovery snapshots include unsent originals, without API credentials. */
export const captureDrafts = (): StoredDraft[] => {
  if (!useDrafts.getState().ready) {
    throw new Error('Drafts are not ready')
  }
  return storedDrafts()
}

export const restoreDrafts = async (records: StoredDraft[]) => {
  await initDrafts()
  if (!useDrafts.getState().ready) {
    throw new Error('Draft storage is unavailable')
  }
  const drafts = new Map<string | null, Draft>()
  const tasks: Record<string, UploadTask> = {}
  for (const record of records) {
    const attachments = record.attachments.map((item): DraftAttachment => {
      const file = new File([item.blob], item.name, {
        type: item.type,
        lastModified: item.lastModified,
      })
      tasks[item.id] = {
        status: 'error',
        retryable: true,
        error: { key: 'draftAttachmentRestored' },
      }
      return {
        id: item.id,
        file,
        isImage: item.isImage,
        previewUrl: item.isImage ? URL.createObjectURL(file) : null,
      }
    })
    if (record.text || attachments.length) {
      drafts.set(record.sessionId, { text: record.text, attachments })
    }
  }
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => releaseAttachment(attachment, true))
  }
  useUploads.setState((state) => ({ tasks: { ...state.tasks, ...tasks } }))
  useDrafts.setState({ drafts })
  if (!(await flushDrafts())) {
    throw new Error('Recovered drafts could not be saved')
  }
}
