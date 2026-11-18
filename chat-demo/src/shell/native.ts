import { Capacitor } from '@capacitor/core'
import { useEffect } from 'react'
import { useTheme } from '../app/theme.js'
import { bindLayerNavigation, closeTopLayer } from './backLayers.js'
export { pushLayer, popLayer, isTopLayer } from './backLayers.js'

/** 跑在 Capacitor 原生壳（Android/iOS）里，而不是浏览器 */
export const isNative = Capacitor.isNativePlatform()

/** 页面底色（浅色 #FFFFFF / 深色 #0F0F0F），状态栏与导航栏都跟随它 */
export const PAGE_BACKGROUND = { light: '#FFFFFF', dark: '#0F0F0F' } as const

/** 原生注入的桥：两条系统栏一起改色（导航栏 Capacitor 没有插件，见 SystemBars.java） */
type SystemBarsBridge = { setDark?: (dark: boolean) => void }

/**
 * 同步状态栏/导航栏：官方 App 的 header 是纯白 + 深色图标、没有分隔线，
 * 所以两条系统栏都不透明、颜色 = 页面底色，图标深浅随主题翻转。
 */
const syncSystemBars = async (theme: 'light' | 'dark') => {
  if (!isNative) {
    return
  }
  const bridge = (window as unknown as { AndroidSystemBars?: SystemBarsBridge }).AndroidSystemBars
  bridge?.setDark?.(theme === 'dark')
  const { StatusBar, Style } = await import('@capacitor/status-bar')
  await Promise.all([
    StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light }),
    StatusBar.setBackgroundColor({ color: PAGE_BACKGROUND[theme] }).catch(() => {}),
  ])
}

/** 用系统浏览器打开外链（原生壳走 Browser 插件，浏览器里就是新标签页） */
export const openExternal = async (url: string) => {
  if (!url) {
    return
  }
  if (isNative) {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url })
    return
  }
  window.open(url, '_blank', 'noopener')
}

/** 全局拦截站外链接：WebView 里 target=_blank 会静默失败，改用系统浏览器打开 */
const interceptExternalLinks = () => {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) {
      return
    }
    const target = event.target as Element | null
    const anchor = target && 'closest' in target ? target.closest('a[href]') : null
    const href = anchor?.getAttribute('href')
    if (!anchor || !href || !/^https?:\/\//i.test(href)) {
      return
    }
    // 站内自跳转（target=_self）不接管
    if (anchor.getAttribute('target') === '_self') {
      return
    }
    event.preventDefault()
    void import('@capacitor/browser').then(({ Browser }) =>
      Browser.open({ url: href, presentationStyle: 'popover' })
    )
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

/** 接管 Android 返回键：先关抽屉/弹窗/二级页，都没有才退出 */
const bindBackButton = () => {
  const listener = import('@capacitor/app').then(({ App }) =>
    App.addListener('backButton', () => {
      if (closeTopLayer()) {
        return
      }
      void App.exitApp()
    })
  )
  return () => { void listener.then((handle) => handle.remove()) }
}

/** 原生壳启动：状态栏跟着 Web 主题走、返回键分层、外链走系统浏览器 */
export const useNativeShell = () => {
  const theme = useTheme()

  useEffect(() => {
    void syncSystemBars(theme)
    // 根画布也刷成页面底色，避免 WebView 回弹时露出白边
    document.documentElement.style.backgroundColor = PAGE_BACKGROUND[theme]
  }, [theme])

  useEffect(() => {
    const cleanNavigation = bindLayerNavigation(isNative)
    if (!isNative) return cleanNavigation
    const cleanLinks = interceptExternalLinks()
    const cleanSystemBack = bindBackButton()
    return () => {
      cleanNavigation()
      cleanLinks()
      cleanSystemBack()
    }
  }, [])
}
