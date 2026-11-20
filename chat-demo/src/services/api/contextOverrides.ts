import { create } from 'zustand'
import { windowDetails } from './windowTiers.js'
import type { ApiProfile } from '../settings.js'
import { endpointProvider, getModelWindow, validWindow, type WindowSpec } from './modelWindows.js'

export const profileWindowKey = (origin: string, model: string, protocol: string) =>
  JSON.stringify([origin.trim().replace(/\/+$/, ''), protocol, model])

/** Only built-in service IDs, wire model IDs and native grant revisions leave the vault. */
const STORAGE = 'chat-demo:model-context-windows:v1'
type Windows = Record<string, number | null>
export function decodeWindows(value: unknown, allowReset = true): Windows | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value).filter(
    ([key, n]) => key.startsWith('[') && (validWindow(n) || (allowReset && n === null))
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}
export const useWindowOverrides = create((): { values: Windows } => {
  try {
    return { values: decodeWindows(JSON.parse(localStorage.getItem(STORAGE) || '{}'), false) || {} }
  } catch {
    return { values: {} }
  }
})
export type ContextTarget = {
  provider?: string
  model: string
  profile?: ApiProfile
  origin?: string
  protocol?: string
  grant?: string
  channel?: 'account' | 'workbuddy'
}
const builtinKey = (target: ContextTarget) =>
  JSON.stringify([
    target.channel || 'preset',
    target.channel ? target.grant || 'offline' : target.provider,
    target.model,
  ])
export function saveBuiltinWindow(target: ContextTarget, value?: number) {
  if (value !== undefined && !validWindow(value)) {
    throw new Error('invalid-context-window')
  }
  const key = builtinKey(target)
  const values = Object.fromEntries(
    Object.entries(useWindowOverrides.getState().values).filter(([id]) => id !== key)
  )
  if (value !== undefined) {
    values[key] = value
  }
  localStorage.setItem(STORAGE, JSON.stringify(values))
  useWindowOverrides.setState({ values })
}
export function profileOverride(profile: ApiProfile, key: string) {
  const n = profile.contextWindows?.[key]
  if (n === null) {
    return undefined
  }
  return validWindow(n) ? n : validWindow(profile.contextWindow) ? profile.contextWindow : undefined
}
export function withProfileWindow(profile: ApiProfile, key: string, value?: number): ApiProfile {
  if (value !== undefined && !validWindow(value)) {
    throw new Error('invalid-context-window')
  }
  const contextWindows = Object.fromEntries(
    Object.entries(profile.contextWindows ?? {}).filter(([id]) => id !== key)
  )
  if (value !== undefined) {
    contextWindows[key] = value
  } else if (validWindow(profile.contextWindow)) {
    contextWindows[key] = null
  } // bypass the legacy all-model setting for this one model
  return { ...profile, contextWindows }
}
export function resolveWindow(target: ContextTarget) {
  const { model, profile } = target
  const origin = target.origin ?? profile?.origin ?? ''
  const provider =
    target.provider ??
    (target.channel === 'account' ? 'deepseek' : target.channel) ??
    endpointProvider(origin, profile?.providerId)
  const key = profileWindowKey(origin, model, target.protocol ?? profile?.protocol ?? '')
  let spec: WindowSpec = getModelWindow(provider, model)
  const discovered = profile?.discoveredWindows?.[key]
  if (validWindow(discovered)) {
    const kind = profile?.discoveredWindowKinds?.[key]
    if (kind === 'model') {
      spec = { ...spec, modelWindow: discovered }
    } else if (kind === 'input') {
      spec = { ...spec, input: discovered, window: discovered, basis: 'input' }
    } else {
      const details = windowDetails(profile?.discoveredWindowDetails?.[key], discovered)
      const budget =
        provider === 'openrouter' && spec.basis === 'variable'
          ? Math.min(spec.window, discovered)
          : discovered
      spec = {
        window: details?.tiers?.at(-1) ?? budget,
        basis: 'discovered',
        urls: [],
        tiers: details?.tiers,
        input: details?.input ?? spec.input,
      }
    }
  }
  const builtins = useWindowOverrides.getState().values
  const presetWindow =
    provider && !target.channel ? builtins[builtinKey({ provider, model })] : undefined
  const inheritedWindow = profile && validWindow(presetWindow) ? presetWindow : undefined
  const manual = profile
    ? profileOverride(profile, key)
    : builtins[builtinKey({ ...target, provider })]
  const preference = manual ?? inheritedWindow ?? spec.window
  // A preference survives a temporary reduction in deployment capacity or account entitlement.
  const constrained = spec.basis === 'discovered' || spec.basis === 'input'
  const window = constrained ? Math.min(preference, spec.window) : preference
  return { spec, key, manual, inheritedWindow, window }
}
