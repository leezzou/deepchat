import { useSettings } from '../services/settings.js'
import { en } from './en.js'
import { zh } from './zh.js'

export type TranslationKey = keyof typeof zh
export type TranslationParams = Record<string, string | number>
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** 带文字链接的提示：link 跟在正文后，在新窗口打开；type 为 error 时前面带错误图标 */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

export const isTranslationKey = (key: unknown): key is TranslationKey =>
  typeof key === 'string' && Object.hasOwn(zh, key)

const createTranslate =
  (messages: Record<TranslationKey, string>) =>
  (key: TranslationKey, params?: TranslationParams): string =>
    messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = params?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
    })

const translators = {
  'zh-CN': createTranslate(zh),
  'en-US': createTranslate(en),
}

/** 把语言偏好解析成实际语言：system 跟随浏览器/系统 */
export const resolveLocale = (preference: string): keyof typeof translators => {
  if (preference === 'zh-CN' || preference === 'en-US') {
    return preference
  }
  return (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** 组件订阅语言变化；普通函数在调用时读取当前语言。 */
export const useTranslate = () =>
  useSettings((state) => translators[resolveLocale(state.locale)])

export const translate = (key: TranslationKey, params?: TranslationParams): string =>
  translators[resolveLocale(useSettings.getState().locale)](key, params)
