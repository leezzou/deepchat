import { create } from 'zustand'

/** 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、切换会话或开启新对话后关闭 */
type ChatOrigin = { sessionId: string; search?: string }
export const useMobileSider = create(() => ({ open: false, chatOrigin: null as ChatOrigin | null, previousChats: [] as string[] }))

export const openMobileSider = () => useMobileSider.setState({ open: true, chatOrigin: null })
export const visitChatFromDrawer = (sessionId: string, search?: string) => {
  if (useMobileSider.getState().open) useMobileSider.setState({ open: false, chatOrigin: { sessionId, search }, previousChats: [] })
}

export const closeMobileSider = () => useMobileSider.setState({ open: false })

export const rememberChat = (id: string) => useMobileSider.setState((state) => ({ previousChats: [...state.previousChats, id] }))
export const takePreviousChat = () => {
  const previous = useMobileSider.getState().previousChats
  useMobileSider.setState({ previousChats: previous.slice(0, -1) })
  return previous.at(-1)
}
