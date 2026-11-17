import { useId, useLayoutEffect } from 'react'
import { create } from 'zustand'

/** Editors and active recordings also block an application-controlled update. */
export const usePendingEdits = create<{ ids: Set<string> }>(() => ({ ids: new Set() }))

export const usePendingEdit = (active: boolean) => {
  const id = useId()
  useLayoutEffect(() => {
    if (!active) {
      return
    }
    usePendingEdits.setState((state) => ({ ids: new Set(state.ids).add(id) }))
    return () =>
      usePendingEdits.setState((state) => {
        const ids = new Set(state.ids)
        ids.delete(id)
        return { ids }
      })
  }, [active, id])
}
