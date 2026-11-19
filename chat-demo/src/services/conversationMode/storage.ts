import { create } from 'zustand'
import { createId } from '../../utils/id.js'

export type PromptTemplate = { id: string; name: string; prompt: string }
export type ConversationMode = { profileId?: string; model?: string; templateId?: string }
type SessionMode = ConversationMode & { sessionId: string }
export type ConversationModeBackup = {
  version: 1
  templates: PromptTemplate[]
  sessions: SessionMode[]
}
const KEY = 'chat-demo:conversation-modes:v1'
export const ACCOUNT_PROFILE = '@account'
// v1 stored built-ins by ID only. Drop their references while retaining the user's other fields.
const retiredTemplateIds = new Set(['translation', 'weekly-report', 'speaking'])
const empty = (): ConversationModeBackup => ({ version: 1, templates: [], sessions: [] })
const invalid = (): never => {
  throw new Error('会话模型或模板数据格式无效')
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    invalid()
  }
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    return invalid()
  }
  return value
}
const identifier = (value: unknown) => {
  const id = text(value, 256)
  if ([...id].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    invalid()
  }
  return id
}
export const isModelId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,255}$/.test(id) && !id.includes('://')

function mode(input: Record<string, unknown>, templateIds: Set<string>): ConversationMode {
  const result: ConversationMode = {}
  if ('profileId' in input) {
    result.profileId = identifier(input.profileId)
  }
  if ('model' in input) {
    if (!isModelId(input.model)) {
      return invalid()
    }
    result.model = input.model
  }
  if ('templateId' in input) {
    const id = identifier(input.templateId)
    if (templateIds.has(id)) {
      result.templateId = id
    } else if (!retiredTemplateIds.has(id)) {
      invalid()
    }
  }
  return result
}
export function validateConversationModes(
  value: unknown,
  sessionIds?: readonly string[]
): ConversationModeBackup {
  const data = object(value, ['version', 'templates', 'sessions'])
  if (
    data.version !== 1 ||
    !Array.isArray(data.templates) ||
    !Array.isArray(data.sessions) ||
    data.templates.length > 512 ||
    data.sessions.length > 100000
  ) {
    return invalid()
  }
  const templateIds = new Set<string>()
  const templates = data.templates.map((row) => {
    const item = object(row, ['id', 'name', 'prompt'])
    const id = identifier(item.id)
    if (templateIds.has(id) || retiredTemplateIds.has(id)) {
      invalid()
    }
    templateIds.add(id)
    return { id, name: text(item.name, 80), prompt: text(item.prompt, 12000) }
  })
  const allowed = sessionIds && new Set(sessionIds)
  const seen = new Set<string>()
  const sessions = data.sessions.map((row) => {
    const item = object(row, ['sessionId', 'profileId', 'templateId', 'model'])
    const sessionId = identifier(item.sessionId)
    if (seen.has(sessionId) || (allowed && !allowed.has(sessionId))) {
      invalid()
    }
    seen.add(sessionId)
    return { sessionId, ...mode(item, templateIds) }
  })
  return { version: 1, templates, sessions }
}

type State = {
  data: ConversationModeBackup
  draft: ConversationMode
  destinations: Map<string | null, string>
}
const initial = (): State => {
  const fallback: State = { data: empty(), draft: {}, destinations: new Map() }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      return fallback
    }
    const saved = JSON.parse(raw)
    const data = validateConversationModes(saved.data)
    const draft = mode(
      object(saved.draft, ['profileId', 'model', 'templateId']),
      new Set(data.templates.map((t) => t.id))
    )
    return { data, draft, destinations: new Map(saved.destinations) }
  } catch {
    return fallback
  }
}
export const useConversationModes = create<State>(initial)
const commit = (next: State) => {
  // Persist before publishing so a quota error leaves the UI and previous snapshot intact.
  localStorage.setItem(KEY, JSON.stringify({ ...next, destinations: [...next.destinations] }))
  useConversationModes.setState(next)
}
export const getConversationMode = (id: string | null): ConversationMode => {
  const { data, draft } = useConversationModes.getState()
  if (id === null) {
    return draft
  }
  const row = data.sessions.find((entry) => entry.sessionId === id)
  return row ? { profileId: row.profileId, model: row.model, templateId: row.templateId } : {}
}
export function setConversationMode(
  id: string | null,
  next: ConversationMode,
  destination?: string
) {
  const state = useConversationModes.getState()
  const destinations = new Map(state.destinations)
  if (destination !== undefined) {
    destinations.set(id, destination)
  }
  if (id === null) {
    commit({ ...state, draft: next, destinations })
    return
  }
  const sessions = state.data.sessions.filter((row) => row.sessionId !== id)
  commit({
    ...state,
    destinations,
    data: { ...state.data, sessions: [...sessions, { sessionId: id, ...next }] },
  })
}
export function promoteConversationMode(
  id: string,
  selected: ConversationMode,
  destination: string,
  after?: () => void
) {
  const state = useConversationModes.getState()
  const destinations = new Map(state.destinations)
  destinations.delete(null)
  destinations.set(id, destination)
  commit({
    draft: {},
    destinations,
    data: { ...state.data, sessions: [...state.data.sessions, { sessionId: id, ...selected }] },
  })
  try {
    after?.()
  } catch (error) {
    commit(state)
    throw error
  }
}
/** A conversation imported from an older build has no verified provider provenance. */
export function flagUnboundSessions(ids: readonly string[]) {
  const state = useConversationModes.getState()
  const destinations = new Map(state.destinations)
  for (const id of ids) {
    if (!destinations.has(id)) {
      destinations.set(id, 'review')
    }
  }
  if (destinations.size !== state.destinations.size) {
    commit({ ...state, destinations })
  }
}
export function removeConversationMode(id: string) {
  const state = useConversationModes.getState()
  const destinations = new Map(state.destinations)
  destinations.delete(id)
  commit({
    ...state,
    destinations,
    data: { ...state.data, sessions: state.data.sessions.filter((row) => row.sessionId !== id) },
  })
}
export function savePromptTemplate(name: string, prompt: string, id = createId()) {
  const state = useConversationModes.getState()
  const template = { id, name: text(name.trim(), 80), prompt: text(prompt.trim(), 12000) }
  if (retiredTemplateIds.has(id)) {
    invalid()
  }
  const templates = [...state.data.templates.filter((row) => row.id !== id), template]
  if (templates.length > 512) {
    throw new Error('自定义模板已达 512 个')
  }
  commit({ ...state, data: { ...state.data, templates } })
  return id
}
export function deletePromptTemplate(id: string) {
  const state = useConversationModes.getState()
  if (!state.data.templates.some((row) => row.id === id)) {
    return
  }
  const detach = <T extends ConversationMode>(row: T): T =>
    row.templateId === id ? { ...row, templateId: undefined } : row
  commit({
    ...state,
    draft: detach(state.draft),
    data: {
      ...state.data,
      templates: state.data.templates.filter((row) => row.id !== id),
      sessions: state.data.sessions.map(detach),
    },
  })
}
export function exportConversationModes(sessionIds?: readonly string[]): ConversationModeBackup {
  const { data } = useConversationModes.getState()
  const allowed = sessionIds && new Set(sessionIds)
  // Explicitly project the portable schema. Local endpoint approvals and the welcome draft stay local.
  return validateConversationModes(
    JSON.parse(
      JSON.stringify({
        version: 1,
        templates: data.templates,
        sessions: data.sessions.filter((row) => !allowed || allowed.has(row.sessionId)),
      })
    ),
    sessionIds
  )
}
export function importConversationModes(value: unknown, sessionIds?: readonly string[]) {
  const data = validateConversationModes(value, sessionIds)
  const state = useConversationModes.getState()
  const templateExists = data.templates.some((row) => row.id === state.draft.templateId)
  commit({
    data,
    draft: templateExists ? state.draft : { ...state.draft, templateId: undefined },
    destinations: new Map(
      (sessionIds ?? data.sessions.map((row) => row.sessionId)).map((id) => [id, 'review'])
    ),
  })
}
export const allTemplates = () => [...useConversationModes.getState().data.templates]
