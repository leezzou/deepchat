import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { searchCapability } from './searchCapabilities.js'
import { isDeepSeekApiOrigin } from './providerParity.js'
import { useSettings } from '../settings.js'
import { hasWorkBuddyBridge } from '../workbuddy/bridge.js'
import { useWorkBuddyState } from '../workbuddy/provider.js'

export type SearchRoute = {
  profileId: string | null
  origin: string
  protocol: string
  model: string
}
export type RetrievalSource = { id: string; label: string }
type Grant = {
  id: string
  target: string
  session: string | null
  source?: string
  query?: string
  claimed?: boolean
  credential?: string
}
// Grants and one-use terms live in memory; neither is exportable or imported with conversations.
const grants = new Map<string, Grant>()
export const useSearchConsent = create(() => ({ revision: 0 }))
const changed = () => useSearchConsent.setState((s) => ({ revision: s.revision + 1 }))
const targetOf = (route: SearchRoute) =>
  JSON.stringify([route.profileId, route.origin, route.protocol, route.model])
export const isPortableGrant = (id?: string) => !!id?.startsWith('portable:')

export function retrievalSources(): RetrievalSource[] {
  const wb = useWorkBuddyState.getState().metadata
  return [
    ...(wb && hasWorkBuddyBridge ? [{ id: 'wb:' + wb.revision, label: 'WorkBuddy' }] : []),
    ...useSettings
      .getState()
      .apiProfiles.filter((p) => p.apiKey && isDeepSeekApiOrigin(p.origin))
      .map((p) => ({ id: 'key:' + p.id, label: `DeepSeek · ${p.name}` })),
  ]
}
function sourceCredential(id: string) {
  return id.startsWith('key:')
    ? useSettings
        .getState()
        .apiProfiles.find((p) => p.id === id.slice(4) && isDeepSeekApiOrigin(p.origin))?.apiKey
    : undefined
}
function grantFor(route: SearchRoute, session?: string | null) {
  return [...grants.values()].find(
    (g) => g.target === targetOf(route) && (g.source ? g.session === (session ?? null) : true)
  )
}
export function routeSearchGrant(route: SearchRoute, session?: string | null) {
  return grantFor(route, session)?.id
}
export function routeSearchEnabled(route: SearchRoute, session?: string | null) {
  return (
    searchCapability(route.origin, route.protocol, route.model) === 'deepseek' ||
    Boolean(routeSearchGrant(route, session))
  )
}
export function revokeSearchGrant(route: SearchRoute, session?: string | null) {
  const old = grantFor(route, session)
  if (old) {
    grants.delete(old.id)
    changed()
  }
}
export function allowSearch(
  route: SearchRoute,
  session: string | null,
  source?: string,
  terms?: string
) {
  const cap = searchCapability(route.origin, route.protocol, route.model)
  const query = terms?.trim()
  if (
    cap === 'none' &&
    (!source ||
      !query ||
      Array.from(query).length > 128 ||
      !retrievalSources().some((s) => s.id === source))
  )
    return false
  if (cap !== 'none' && (source || cap === 'deepseek')) return false
  revokeSearchGrant(route, session)
  const id = `${cap === 'none' ? 'portable' : cap}:${createId()}`
  grants.set(id, {
    id,
    target: targetOf(route),
    session,
    source,
    query,
    credential: source && sourceCredential(source),
  })
  changed()
  return true
}
export function promoteSearchGrant(route: SearchRoute, session: string) {
  const grant = grantFor(route, null)
  if (grant?.source) grant.session = session
}
export function takeSearchGrant(id: string) {
  const grant = grants.get(id)
  if (
    !grant?.source ||
    !grant.query ||
    grant.claimed ||
    !retrievalSources().some((s) => s.id === grant.source) ||
    grant.credential !== sourceCredential(grant.source)
  ) {
    if (!grant?.claimed) finishSearchGrant(id)
    throw new Error('Search authorization changed. / 搜索授权已变更，请重新选择。')
  }
  grant.claimed = true
  return { source: grant.source, query: grant.query, credential: grant.credential }
}
export function finishSearchGrant(id: string) {
  if (grants.delete(id)) changed()
}
