import { defaultApiOrigin, normalizeOrigin } from '../api/origin.js'
import { allowsKeylessLocal, validWindow } from '../api/modelWindows.js'
import { decodeWindows } from '../api/contextOverrides.js'
import { restoreClaudeFacts } from '../api/anthropicOfficial.js'
import type { ApiProfile } from '../settings.js'

export const LEGACY_LIST = 'chat-demo:api-profiles'
export const LEGACY_KEY = 'chat-demo:api-key'
export type ProfileVault = {
  read(): Promise<string | null>
  write(value: string): Promise<unknown>
}
type LegacyStore = Pick<Storage, 'getItem' | 'removeItem'>

function decodeList(text: string): ApiProfile[] {
  const list: unknown = JSON.parse(text)
  if (!Array.isArray(list)) {
    throw new Error('invalid-profile-list')
  }
  return list.map((raw, i) => {
    if (!raw || typeof raw.apiKey !== 'string' || (!raw.apiKey && !allowsKeylessLocal(raw.origin, raw.protocol))) {
      throw new Error('invalid-profile')
    }
    const reasoning = Object.entries(raw.discoveredReasoning ?? {}).filter(([key, v]) =>
      key.startsWith('[') && (v === 'toggle' || v === 'fixed' || v === 'none'))
    const discoveredWindows = decodeWindows(raw.discoveredWindows, false) as Record<string, number> | undefined
    const kinds = Object.entries(raw.discoveredWindowKinds ?? {}).filter(([key, kind]) =>
      discoveredWindows?.[key] && ['input', 'endpoint', 'instance', 'model'].includes(String(kind)))
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : `legacy-${i + 1}`,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'DeepSeek',
      protocol: raw.protocol === 'anthropic' || raw.protocol === 'openai' ? raw.protocol : 'deepseek',
      origin: normalizeOrigin(typeof raw.origin === 'string' ? raw.origin : ''),
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      ...(raw.claudeModelFacts && { claudeModelFacts: restoreClaudeFacts(raw.origin, raw.claudeModelFacts) }),
      contextWindow: validWindow(raw.contextWindow) ? raw.contextWindow : undefined,
      ...(decodeWindows(raw.contextWindows) && { contextWindows: decodeWindows(raw.contextWindows) }),
      ...(reasoning.length && { discoveredReasoning: Object.fromEntries(reasoning) as ApiProfile['discoveredReasoning'] }),
      ...(discoveredWindows && { discoveredWindows }),
      ...(kinds.length && { discoveredWindowKinds: Object.fromEntries(kinds) as ApiProfile['discoveredWindowKinds'] }),
      ...(typeof raw.providerId === 'string' && { providerId: raw.providerId }),
      apiKey: raw.apiKey,
    }
  })
}

// Preserve both records in the unusual case of an upgrade after a downgrade or an interrupted migration.
function merge(target: ApiProfile[], input: ApiProfile) {
  let id = input.id
  for (let index = 2; ; index++) {
    const existing = target.find((item) => item.id === id)
    if (!existing) {
      target.push({ ...input, id })
      return
    }
    if (JSON.stringify(existing) === JSON.stringify({ ...input, id })) {
      return
    }
    id = `${input.id}-legacy-${index}`
  }
}

export function decodeLegacy(list: string | null, key: string | null) {
  const profiles: ApiProfile[] = []
  if (list !== null) {
    for (const profile of decodeList(list)) {
      merge(profiles, profile)
    }
  }
  if (key && !profiles.some((profile) => profile.apiKey === key)) {
    merge(profiles, {
      id: 'default',
      name: profiles.length ? 'DeepSeek (legacy)' : 'DeepSeek',
      protocol: 'deepseek',
      origin: defaultApiOrigin,
      model: '',
      apiKey: key,
    })
  }
  return profiles
}

export function encodeProfiles(profiles: ApiProfile[]) {
  return JSON.stringify({ version: 1, profiles })
}
export async function persistProfiles(vault: ProfileVault, profiles: ApiProfile[]) {
  const text = encodeProfiles(profiles)
  await vault.write(text)
  if ((await vault.read()) !== text) {
    throw new Error('readback-failed')
  }
}
export async function migrateProfiles(vault: ProfileVault, legacy: LegacyStore) {
  // Strict reads here: inaccessible storage must not be mistaken for an empty installation.
  const oldList = legacy.getItem(LEGACY_LIST)
  const oldKey = legacy.getItem(LEGACY_KEY)
  const oldProfiles = decodeLegacy(oldList, oldKey)
  const saved = await vault.read()
  let profiles: ApiProfile[] = []
  if (saved !== null) {
    const record = JSON.parse(saved)
    if (record?.version !== 1) {
      throw new Error('unsupported-version')
    }
    profiles = decodeList(JSON.stringify(record.profiles))
  }
  if (oldList !== null || oldKey !== null) {
    for (const item of oldProfiles) {
      merge(profiles, item)
    }
    // A resumed migration must confirm the durable copy again before touching either source.
    await persistProfiles(vault, profiles)
    if (legacy.getItem(LEGACY_LIST) !== oldList || legacy.getItem(LEGACY_KEY) !== oldKey) {
      throw new Error('legacy-changed')
    }
    // Clear the redundant single Key first so a crash cannot restore it as a spurious new profile.
    legacy.removeItem(LEGACY_KEY)
    legacy.removeItem(LEGACY_LIST)
    if (legacy.getItem(LEGACY_KEY) !== null || legacy.getItem(LEGACY_LIST) !== null) {
      throw new Error('cleanup-failed')
    }
  }
  return profiles
}
