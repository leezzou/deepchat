import type { TranslationKey } from '../i18n/index.js'
import { estimateRequestTokens } from './chat/contextBudget.js'

export const INLINE_TEXT_ACCEPT = '.txt,.md,.markdown,text/plain,text/markdown,text/x-markdown'
const MAX_BYTES = 128 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const textHeader = /^\[(?:Text file: |文件正文：)/m

/** When deriving a search query, only consider the question preceding the inserted files. */
export function beforeInlineTextFiles(value: string) {
  const at = value.search(textHeader)
  return at < 0 ? value : value.slice(0, at).trimEnd()
}

type ReadResult = { text: string } | { error: TranslationKey }

/** Validate the whole selection first. Never upload, create file IDs, or insert a partial batch. */
export async function readInlineTextFiles(files: File[], english: boolean): Promise<ReadResult> {
  if (files.length > 8 || files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) {
    return { error: 'inlineFileSize' }
  }
  for (const file of files) {
    const mime = file.type.split(';')[0].trim().toLowerCase()
    if (
      !/\.(txt|md|markdown)$/i.test(file.name) ||
      !['', 'text/plain', 'text/markdown', 'text/x-markdown', 'application/octet-stream'].includes(
        mime
      )
    ) {
      return { error: 'inlineFileFormat' }
    }
  }
  const parts: string[] = []
  for (const file of files) {
    let bytes: ArrayBuffer
    try {
      bytes = await file.arrayBuffer()
    } catch {
      return { error: 'inlineFileRead' }
    }
    let text: string
    try {
      text = decoder.decode(bytes)
    } catch {
      return { error: 'inlineFileEncoding' }
    }
    // Reject binary controls (including ASCII UTF-16 encoded with interleaved NULs), and renamed PDFs.
    if (/\p{Cc}/u.test(text.replace(/[\t\n\r\f]/g, '')) || /^%PDF-\d+\.\d+/u.test(text)) {
      return { error: 'inlineFileFormat' }
    }
    if (!text.trim()) {
      return { error: 'inlineFileEmpty' }
    }
    const name = (file.name.split(/[\\/]/).pop() ?? '').replace(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\]]/gu,
      '_'
    )
    parts.push(`[${english ? 'Text file: ' : '文件正文：'}${name}]\n${text}`)
  }
  return { text: parts.join('\n\n') }
}

export function appendInlineText(
  draft: string,
  insertion: string,
  contextWindow: number,
  inputLimit?: number
): ReadResult {
  const text = draft ? `${draft}\n\n${insertion}` : insertion
  // Repeated picks must not create an unbounded text preview or synchronous draft journal.
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) {
    return { error: 'inlineDraftSize' }
  }
  if (
    estimateRequestTokens([{ role: 'user', content: text }]) >=
    Math.min(contextWindow * 0.95, inputLimit ?? Infinity)
  ) {
    return { error: 'inlineFileWindow' }
  }
  return { text }
}
