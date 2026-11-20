/** Published OpenAI endpoint and effort contracts. Keep vendor aliases at other origins opaque. */
export const isOpenAiOrigin = (origin: string) =>
  origin.replace(/\/+$/u, '') === 'https://api.openai.com/v1'

// https://developers.openai.com/api/docs/models -- Pro and Codex families have Responses-only variants.
const responsesOnly = new Set([
  'gpt-5-pro',
  'gpt-5.2-pro',
  'gpt-5.4-pro',
  'gpt-5.5-pro',
  'o1-pro',
  'o3-pro',
  'codex-mini-latest',
  'gpt-5-codex',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
])
const stripSnapshot = (id: string) => id.replace(/-\d{4}-\d{2}-\d{2}$/u, '')
export const usesOpenAiResponses = (id: string) => responsesOnly.has(stripSnapshot(id))
// Request streaming only for variants with verified streaming support. Others provide a complete JSON Response.
export const streamsOpenAiResponses = (id: string) =>
  /^gpt-5(?:\.\d+)?-codex(?:-|$)/u.test(id) ||
  ['gpt-5-pro', 'gpt-5.2-pro', 'gpt-5.4-pro'].includes(stripSnapshot(id))
// https://developers.openai.com/api/docs/guides/latest-model and the model-specific effort tables.
const switchable = new Set([
  'gpt-5.1',
  'gpt-5.2',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.5',
  'gpt-5.6',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-terra',
])
export const hasOpenAiThinkingToggle = (id: string) => switchable.has(stripSnapshot(id))

// https://developers.openai.com/api/docs/guides/tools-web-search -- the standard hosted tool requires Responses.
const searchable = new Set([
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6.2-astra',
  'gpt-6.2-sol',
  'gpt-5-pro',
  'gpt-5.2-pro',
  'gpt-5.4-pro',
  'gpt-5.5-pro',
])
export const supportsOpenAiSearch = (id: string) => searchable.has(stripSnapshot(id))

/** The official /models list also includes embeddings, speech, research and legacy completions. */
export function isOpenAiChatModel(id: string): boolean {
  if (usesOpenAiResponses(id)) {
    return true
  }
  if (id.startsWith('ft:')) {
    return isOpenAiChatModel(id.split(':')[1] ?? '')
  }
  if (/(?:instruct|transcribe|realtime|tts|deep-research|image|cyber|codex|daybreak)/u.test(id)) {
    return false
  }
  return /^(?:gpt-(?:3\.5-turbo|4(?:[.o-]|$)|[56](?:[.-]|$))|o[134](?:-|$)|chat(?:gpt-4o)?-latest$)/u.test(
    id
  )
}
