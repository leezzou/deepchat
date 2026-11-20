import { useMemo } from 'react'
import { saveIdentityPreference, useSettings, type IdentitySource } from './settings.js'
import { useWorkBuddyState } from './workbuddy/provider.js'

export type AccountIdentity = {
  source: IdentitySource
  revision: string
  name: string
  avatar: string | null
}

function resolveAccountIdentity(
  dshRevision: string | null,
  dshName: string,
  dshAvatar: string | null,
  wbRevision: string | null,
  wbName: string,
  wbAvatar: string | null,
  preference: IdentitySource
) {
  const dsh: AccountIdentity | null = dshRevision
    ? { source: 'dsh', revision: dshRevision, name: dshName || 'DSH', avatar: dshAvatar }
    : null
  const workbuddy: AccountIdentity | null = wbRevision
    ? { source: 'workbuddy', revision: wbRevision, name: wbName || 'WorkBuddy', avatar: wbAvatar }
    : null
  const selected = preference === 'workbuddy' ? (workbuddy ?? dsh) : (dsh ?? workbuddy)
  return { dsh, workbuddy, selected, canChoose: !!(dsh && workbuddy) }
}

/** The preference chooses between verified providers. It never chooses the chat transport. */
export function setIdentityPreference(source: IdentitySource) {
  const settings = useSettings.getState()
  if (
    (source === 'dsh' || source === 'workbuddy') &&
    settings.accountSignedIn &&
    settings.accountDisplayRevision &&
    useWorkBuddyState.getState().identityRevision
  ) {
    saveIdentityPreference(source)
  }
}

export function useAccountIdentity() {
  const dshRevision = useSettings((s) => (s.accountSignedIn ? s.accountDisplayRevision : null))
  const dshName = useSettings((s) => s.accountName)
  const dshAvatar = useSettings((s) => s.accountAvatar)
  const preference = useSettings((s) => s.identityPreference)
  const wbRevision = useWorkBuddyState((s) => s.identityRevision)
  const wbName = useWorkBuddyState((s) => s.name)
  const wbAvatar = useWorkBuddyState((s) => s.avatar)
  return useMemo(
    () =>
      resolveAccountIdentity(
        dshRevision,
        dshName,
        dshAvatar,
        wbRevision,
        wbName,
        wbAvatar,
        preference
      ),
    [dshRevision, dshName, dshAvatar, wbRevision, wbName, wbAvatar, preference]
  )
}
