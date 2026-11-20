import type { TextCitation } from './types.js'

export function publicSourceUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 8192) return
  try {
    const url = new URL(raw)
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
      return url.href
  } catch {
    /* Provider omitted a usable link. */
  }
  return undefined
}
export const asRecord = (item: unknown): Record<string, unknown> =>
  item !== null && typeof item === 'object' && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : {}
export function firstChoice(payload: unknown) {
  const choices = asRecord(payload).choices
  return asRecord(Array.isArray(choices) && choices[0])
}

/** Citations can be carried by an annotation-only final chunk. Never mine model prose for sources. */
export function readChatCitations(payload: unknown, seen: Set<string>): TextCitation[] {
  const choice = firstChoice(payload)
  const citations: TextCitation[] = []
  for (const part of [asRecord(choice.delta), asRecord(choice.message)]) {
    if (!Array.isArray(part.annotations)) continue
    for (const item of part.annotations) {
      if (asRecord(item).type !== 'url_citation') continue
      const row = asRecord(item.url_citation)
      const url = publicSourceUrl(row.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      citations.push({
        type: 'web_search_result_location',
        url,
        title: typeof row.title === 'string' ? row.title : null,
        cited_text: '',
        encrypted_index: '',
      })
    }
  }
  return citations
}
