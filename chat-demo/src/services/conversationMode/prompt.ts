import { getSessionMemoryTexts } from '../library/index.js'
import { allTemplates, getConversationMode } from './storage.js'

export function conversationInstructions(sessionId: string | null) {
  const templateId = getConversationMode(sessionId).templateId
  const template = allTemplates().find((item) => item.id === templateId)
  const memories = getSessionMemoryTexts(sessionId)
  const system = [
    template?.prompt,
    memories.length
      ? `用户选用的本地记忆：\n${memories.map((text) => `- ${text}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { system: system || undefined, memories }
}
