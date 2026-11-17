import { getVisibleMessages, normalizeSession } from './branches.js'
import type { Session } from './types.js'

export type MessageDeletionMode = 'single' | 'following'

/** following 包含目标所有后代（含隐藏回答版本）；只允许当前路径中的目标。 */
export const previewMessageDeletion = (
  original: Session,
  messageId: string,
  mode: MessageDeletionMode
): { messageIds: string[] } => {
  const session = normalizeSession(original)
  if (!getVisibleMessages(session).some((message) => message.id === messageId)) {
    return { messageIds: [] }
  }
  const removed = new Set([messageId])
  if (mode === 'following') {
    const children = new Map<string, string[]>()
    for (const message of session.messages) {
      if (message.parentId) {
        children.set(message.parentId, [...(children.get(message.parentId) ?? []), message.id])
      }
    }
    const queue = [messageId]
    for (let index = 0; index < queue.length; index++) {
      for (const id of children.get(queue[index]) ?? []) {
        if (!removed.has(id)) {
          removed.add(id)
          queue.push(id)
        }
      }
    }
  }
  return {
    messageIds: session.messages
      .filter((message) => removed.has(message.id))
      .map((message) => message.id),
  }
}

/** 删除单条时保留后代并重接分支，回答的原始问题锚点独立于新的树结构。 */
export const buildMessageDeletion = (
  original: Session,
  messageId: string,
  mode: MessageDeletionMode,
  expectedIds?: string[]
): { session: Session; removedFileIds: string[] } | null => {
  const { messageIds } = previewMessageDeletion(original, messageId, mode)
  const removed = new Set(messageIds)
  if (
    !removed.size ||
    (expectedIds &&
      (expectedIds.length !== removed.size ||
        expectedIds.some((id) => !removed.has(id)) ||
        new Set(expectedIds).size !== removed.size))
  ) {
    return null
  }
  const session = normalizeSession(original)
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const target = byId.get(messageId)
  if (!target) {
    return null
  }
  const directChildren = session.messages.filter(
    (message) => message.parentId === messageId && !removed.has(message.id)
  )
  const replacement =
    directChildren.find((message) => message.id === target.selectedChildId) ??
    directChildren.at(-1) ??
    session.messages
      .filter((message) => message.parentId === target.parentId && !removed.has(message.id))
      .at(-1)
  const messages = session.messages
    .filter((message) => !removed.has(message.id))
    .map((message) => {
      let next = message
      if (message.role === 'assistant') {
        const originalParent = message.parentId ? byId.get(message.parentId) : undefined
        const contextUserId =
          message.contextUserId === undefined
            ? originalParent?.role === 'user'
              ? originalParent.id
              : null
            : message.contextUserId
        next = {
          ...message,
          contextUserId: contextUserId && removed.has(contextUserId) ? null : contextUserId,
        }
      }
      if (mode === 'single' && next.parentId === messageId) {
        next = { ...next, parentId: target.parentId ?? null }
      }
      if (next.id === target.parentId && next.selectedChildId === messageId) {
        next = { ...next, selectedChildId: replacement?.id }
      }
      return next
    })
  const retainedFiles = new Set(
    messages.flatMap((message) =>
      message.role === 'user' ? message.files.map((file) => file.id) : []
    )
  )
  const removedFileIds = [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' && removed.has(message.id)
          ? message.files.filter((file) => !retainedFiles.has(file.id)).map((file) => file.id)
          : []
      )
    ),
  ]
  const next: Session = {
    ...session,
    messages,
    rootMessageId:
      session.rootMessageId === messageId ? (replacement?.id ?? null) : session.rootMessageId,
    excludedContextRoundIds: session.excludedContextRoundIds?.filter((id) => !removed.has(id)),
    updatedAt: Date.now(),
  }
  const covered = session.checkpoint?.coveredMessageIds
  if (
    (session.checkpoint && !covered) ||
    covered?.some((id) => removed.has(id)) ||
    (session.compactedThrough && removed.has(session.compactedThrough))
  ) {
    delete next.checkpoint
    delete next.compactedThrough
  }
  return { session: next, removedFileIds }
}
