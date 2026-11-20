import { create } from 'zustand'
import type { LinkedMessage } from '../../i18n/index.js'

/** 轻提示：同一时间只显示一条，新的替换旧的，到时自动消失；文案在渲染时按当前语言翻译 */
type ToastState = { id: number; message: LinkedMessage | string | null }

export const useToast = create<ToastState>(() => ({ id: 0, message: null }))

const DURATION = 3000
/** 带链接时多留一些时间，方便点击 */
const LINK_DURATION = 5000
let timer = 0

export const showToast = (message: LinkedMessage | string, durationMs?: number) => {
  window.clearTimeout(timer)
  useToast.setState((state) => ({ id: state.id + 1, message }))
  const duration = typeof message !== 'string' && message.link ? LINK_DURATION : DURATION
  timer = window.setTimeout(() => useToast.setState({ message: null }), durationMs ?? duration)
  return useToast.getState().id
}

/** Dismiss only the caller’s notice, even if a more important toast replaced it. */
export const dismissToast = (id: number | undefined) => {
  if (id !== useToast.getState().id) {
    return
  }
  window.clearTimeout(timer)
  useToast.setState({ message: null })
}
