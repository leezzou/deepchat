import type { MessageParam } from '../api/types.js'

/** 只作预算：汉字、非 ASCII 按 1 token，ASCII 按 3 字符，含协议及附件余量。 */
export const estimateTokens = (text: string): number => {
  let nonAscii = 0
  for (const character of text) {
    if (character.charCodeAt(0) > 127) {
      nonAscii += character.length
    }
  }
  return Math.ceil(nonAscii + (text.length - nonAscii) / 3)
}

export const estimateRequestTokens = (messages: MessageParam[]): number => {
  let attachments = 0
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'image') {
          attachments += 2048
        }
        if (block.type === 'document') {
          attachments += 4096
        }
      }
    }
  }
  return estimateTokens(JSON.stringify(messages)) + attachments + 256
}

/** 限长分块不会丢弃尾部，避免对单个超长轮次简单截断。 */
export const splitContextText = (text: string, budget: number): string[] => {
  const chunks: string[] = []
  let chunk = ''
  let cost = 0
  for (const character of text) {
    const next = character.charCodeAt(0) > 127 ? character.length : 1 / 3
    if (chunk && cost + next > budget) {
      chunks.push(chunk)
      chunk = ''
      cost = 0
    }
    chunk += character
    cost += next
  }
  if (chunk) {
    chunks.push(chunk)
  }
  return chunks
}
