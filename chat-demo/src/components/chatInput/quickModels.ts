import { useEffect, useState } from 'react'
import { workBuddyRateLabel } from '../settings/workBuddyRateLabel.js'
import { getConversationRoute } from '../../services/api/access.js'
import { loadCatalogModels } from '../../services/api/modelCatalog.js'
import { discoverModels, type DiscoveredModel } from '../../services/api/modelDiscovery.js'
import { allowsKeylessLocal, endpointProvider } from '../../services/api/modelWindows.js'
import { isOpenAiChatModel, isOpenAiOrigin } from '../../services/api/openAiModels.js'
import { isModelId } from '../../services/conversationMode/storage.js'
import { refreshWorkBuddyCatalog, useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { WORKBUDDY_PROFILE } from '../../services/workbuddy/models.js'

export type Route = ReturnType<typeof getConversationRoute>
export type ModelRow = {
  id: string
  name: string
  detail?: string
  price?: string
  free?: boolean
  live?: DiscoveredModel
}
const native: ModelRow[] = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek Pro' },
]
export const nativeModelName = (id: string) => native.find((r) => r.id === id)?.name || id

/** Discovery runs only for the reviewed destination while its menu is open. */
export function useQuickModels(route: Route, en: boolean) {
  const { models, catalogStale, metadata } = useWorkBuddyState()
  const wb = route.profileId === WORKBUDDY_PROFILE
  const profile = route.profile
  const [api, setApi] = useState<{ rows: ModelRow[]; checking: boolean; fallback?: boolean }>({
    rows: [],
    checking: true,
  })
  useEffect(() => {
    if (wb && metadata?.revision && !route.needsApproval && !route.missing) {
      void refreshWorkBuddyCatalog().catch(() => {})
    }
  }, [wb, metadata?.revision, route.needsApproval, route.missing])
  useEffect(() => {
    if (wb || route.needsApproval || route.missing || route.protocol === 'deepseek' || !profile) {
      return
    }
    const controller = new AbortController()
    const provider = endpointProvider(profile.origin, profile.providerId) ?? 'custom'
    const fromCatalog = async () =>
      (await loadCatalogModels(provider))
        .filter(
          (m) =>
            m.scope !== 'local-reference' &&
            (m.supportsChatCompletions !== false ||
              (isOpenAiOrigin(profile.origin) && isOpenAiChatModel(m.id))) &&
            isModelId(m.id)
        )
        .map((m) => ({ id: m.id, name: m.name }))
    const canLoad = Boolean(profile.apiKey || allowsKeylessLocal(profile.origin, profile.protocol))
    const timer = setTimeout(() => controller.abort(), 12000)
    let mounted = true
    async function load() {
      try {
        if (canLoad && profile) {
          const live = await discoverModels(
            { providerId: provider, endpoint: profile.origin, apiKey: profile.apiKey },
            controller.signal
          )
          if (mounted) {
            setApi({
              rows: live
                .filter((m) => isModelId(m.id))
                .map((m) => ({ id: m.id, name: m.name, live: m })),
              checking: false,
            })
          }
          return
        }
      } catch {
        /* A disconnected provider can still use its bundled catalog. */
      }
      if (mounted) {
        const rows = await fromCatalog().catch(() => [])
        if (mounted) {
          setApi({ rows, checking: false, fallback: true })
        }
      }
    }
    void load().finally(() => clearTimeout(timer))
    return () => {
      mounted = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [profile, route.missing, route.needsApproval, route.protocol, wb])
  if (wb) {
    return {
      rows: models.map(
        (m): ModelRow => ({
          id: m.id,
          name: m.name,
          detail: m.id.toLowerCase() === m.name.toLowerCase() ? undefined : m.id,
          price: workBuddyRateLabel(m, en, true),
          free: m.rate?.free,
        })
      ),
      note:
        catalogStale && models.some((m) => m.source === 'account') ? (en ? 'Cached' : '缓存') : '',
    }
  }
  if (route.protocol === 'deepseek') {
    return {
      rows: native.map((m, i) => ({
        ...m,
        detail: i === 0 ? (en ? 'Fast replies' : '快速回答') : en ? 'Complex tasks' : '复杂任务',
      })),
      note: '',
    }
  }
  const rows = api.rows.slice()
  if (route.model && !rows.some((m) => m.id === route.model)) {
    rows.unshift({ id: route.model, name: route.model, detail: en ? 'Configured' : '当前配置' })
  }
  const note =
    api.checking && profile
      ? en
        ? 'Loading…'
        : '获取中…'
      : api.fallback
        ? en
          ? 'Offline catalog'
          : '离线目录'
        : ''
  return { rows, note }
}
