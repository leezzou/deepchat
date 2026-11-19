import type { TranslationMessage } from '../../i18n/index.js'
import {
  knownPlainTextBytes,
  MAX_DOCUMENT_REFERENCES,
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_IMAGE_REFERENCES,
  MAX_IMAGE_TOTAL_BYTES,
} from '../attachmentLimits.js'
import type { MessageParam } from '../api/types.js'
import type { FileAttachment, Message } from './types.js'

/** Local metadata stays out of the wire payload. Look up sizes only for references actually sent. */
export function indexRequestFiles(messages: Message[]): ReadonlyMap<string, FileAttachment> {
  const files = new Map<string, FileAttachment>()
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      if (file.serverId) {
        files.set(file.serverId, file)
      }
    }
  }
  return files
}

type RequestFiles = ReturnType<typeof indexRequestFiles>

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

function requestAttachmentUsage(messages: MessageParam[], files?: RequestFiles) {
  let images = 0,
    documents = 0,
    imageBytes = 0,
    textBytes = 0,
    tokens = 0
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') {
      continue
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        continue
      }
      const file = files?.get(block.source.file_id)
      if (block.type === 'image') {
        images++
        imageBytes += file?.size ?? 0
        tokens += 1024 // Maximum tokens after DeepSeek resizes a single image.
      } else {
        documents++
        const bytes = file ? knownPlainTextBytes(file) : 0
        textBytes += bytes
        // Binary documents' extracted text and crops are only known to the server.
        tokens += bytes ? Math.ceil(bytes / 3) : 4096
      }
    }
  }
  return { images, documents, imageBytes, textBytes, tokens }
}

/** Count occurrences in the final wire messages, including historical and repeated references. */
export function requestFileLimit(
  messages: MessageParam[],
  files: RequestFiles
): TranslationMessage | null {
  const { images, documents, imageBytes, textBytes } = requestAttachmentUsage(messages, files)
  if (documents > MAX_DOCUMENT_REFERENCES) {
    return {
      key: 'contextDocumentCount',
      params: { count: documents, limit: MAX_DOCUMENT_REFERENCES },
    }
  }
  if (textBytes > MAX_DOCUMENT_TEXT_BYTES) {
    return { key: 'contextDocumentTextLimit' }
  }
  if (images > MAX_IMAGE_REFERENCES || imageBytes > MAX_IMAGE_TOTAL_BYTES) {
    return { key: 'contextImageLimit' }
  }
  return null
}

export const estimateRequestTokens = (messages: MessageParam[], files?: RequestFiles): number =>
  estimateTokens(JSON.stringify(messages)) + requestAttachmentUsage(messages, files).tokens + 256

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
