import { useLayoutEffect, useRef, useState } from 'react'

// Modal/sheet exit matches --nav-exit. Smaller anchored surfaces settle sooner.
export const MODAL_EXIT_MS = 180
export const POPOVER_EXIT_MS = 120

/** Reopening/unmounting cancels the exit, including any pending selection handoff. */
export const afterMotionExit = (duration: number, done: () => void) => {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (preference.matches) {
    done()
    return
  }
  const finish = () => {
    cleanup()
    done()
  }
  const onPreferenceChange = () => {
    if (preference.matches) {
      finish()
    }
  }
  const timer = window.setTimeout(finish, duration)
  const cleanup = () => {
    window.clearTimeout(timer)
    preference.removeEventListener('change', onPreferenceChange)
  }
  preference.addEventListener('change', onPreferenceChange)
  return cleanup
}

export const useMotionPresence = (open: boolean, duration: number, onExited?: () => void) => {
  const [retained, setRetained] = useState(open)
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited
  useLayoutEffect(() => {
    if (open) {
      setRetained(true)
    } else if (retained) {
      return afterMotionExit(duration, () => {
        setRetained(false)
        onExitedRef.current?.()
      })
    }
    return undefined
  }, [open, retained, duration])
  return { present: open || retained, closing: !open && retained }
}
