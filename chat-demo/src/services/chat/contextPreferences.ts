import { create } from 'zustand'

const KEY = 'chat-demo:auto-context-compaction'
const readAuto = () => {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

/** 自动摘要是本机偏好，不写入 API 配置或聊天原文。 */
export const useContextPreferences = create<{ autoCompact: boolean }>(() => ({
  autoCompact: readAuto(),
}))

export const setAutoCompact = (autoCompact: boolean) => {
  useContextPreferences.setState({ autoCompact })
  try {
    localStorage.setItem(KEY, String(autoCompact))
  } catch {
    /* 存储受限时本次仍生效 */
  }
}
