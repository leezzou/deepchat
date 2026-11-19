import type { ChatAccess } from './api/access.js'

/** A generic Chat Completions endpoint can define different file limits. */
export function usesDeepSeekFileLimits(access: ChatAccess): boolean {
  if (access.source === 'account' || access.config.protocol === 'deepseek') {
    return true
  }
  try {
    return new URL(access.config.origin).origin === 'https://api.deepseek.com'
  } catch {
    return false
  }
}

/** DeepSeek document_parsing and vision limits. Each occurrence of a file_id counts. */
export const MAX_DOCUMENT_REFERENCES = 20
export const MAX_DOCUMENT_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_REFERENCES = 600
export const MAX_IMAGE_TOTAL_BYTES = 200 * 1024 * 1024

/** Only verbatim text formats have a useful byte count before server-side parsing. */
export function knownPlainTextBytes(file: {
  name: string
  size: number
  mimeType: string
}): number {
  // Office, e-books, PDF and other containers can expand or shrink substantially when parsed.
  if (/\.(pdf|docx?|pptx?|xlsx?|epub|mobi)$/i.test(file.name)) {
    return 0
  }
  if (!Number.isFinite(file.size) || file.size < 0) {
    return 0
  }
  const mime = (file.mimeType ?? '').toLowerCase()
  if (mime.includes('charset=') && !/charset=["']?(utf-8|us-ascii)\b/i.test(mime)) {
    return 0
  }
  return mime.startsWith('text/') ||
    /\.(txt|md|csv|tsv|log|json|jsonl|xml|html?|css|jsx?|tsx?|py|c|cpp|h|java|go|rs|ya?ml|ini|conf|sh|toml)$/i.test(
      file.name
    )
    ? file.size
    : 0
}
