import { createRoot } from 'react-dom/client'
import { setupTheme } from './app/theme.js'
import { WhaleLogo } from './components/base/WhaleLogo.js'
import { Button } from './components/base/Button.js'
import { initializeCredentials } from './services/settings.js'
import {
  hasSecurityPort,
  isSecurityUnlocked,
  refreshSecurity,
  subscribeSecurity,
} from './services/security/bridge.js'
import './app/theme.css'
import './app/global.css'

setupTheme()
const root = createRoot(document.getElementById('root') as HTMLElement)
const chinese = navigator.language.toLowerCase().startsWith('zh')
const text = (zh: string, en: string) => (chinese ? zh : en)
let working = false
let mounted = false
let credentialFailure = false
let resumeStartup: boolean | null = null
let unsubscribe = () => {}

function notice(message: string, actions?: { title: string; run(): void }[]) {
  root.render(
    <main className="dc-startup" role="status">
      <WhaleLogo />
      <h1>DeepChat</h1>
      <p>{message}</p>
      {actions && (
        <div className="dc-startup-actions">
          {actions.map((action, index) => (
            <Button key={action.title} variant={index === 0 ? 'primary' : 'outlined'} onClick={action.run}>
              {action.title}
            </Button>
          ))}
        </div>
      )}
    </main>
  )
}

async function start(readOnly = false) {
  if (mounted || working) {
    return
  }
  working = true
  resumeStartup = null
  try {
    await refreshSecurity()
    if (hasSecurityPort && !isSecurityUnlocked()) {
      resumeStartup = readOnly
      notice(text('等待设备身份验证。', 'Waiting for device verification.'))
      return
    }
    if (!readOnly) {
      try {
        await initializeCredentials()
        credentialFailure = false
      } catch {
        if (hasSecurityPort && !isSecurityUnlocked()) {
          resumeStartup = readOnly
          return
        }
        credentialFailure = true
        notice(
          text(
            '尚未确认 API 配置的安全副本。请解锁设备、检查存储空间或更新系统 WebView，再重试。你也可以先查看对话。',
            'Your API credentials could not be verified in secure storage. Unlock the device, check free space or update WebView, then retry. You can still view your chats.'
          ),
          [
            { title: text('重试', 'Retry'), run: () => void start() },
            { title: text('查看对话', 'View chats'), run: () => void start(true) },
          ]
        )
        return
      }
    }
    await (await import('./services/backup/portableMetadata.js')).recoverPortableRestore()
    const [{ App }, { ensureKatex }] = await Promise.all([
      import('./app/App.js'),
      import('./services/markdown/katex.js'),
    ])
    if (hasSecurityPort && !isSecurityUnlocked()) {
      resumeStartup = readOnly
      return
    }
    ensureKatex()
    mounted = true
    unsubscribe()
    root.render(<App />)
  } catch {
    notice(
      text(
        '无法完成启动检查。请确认设备已解锁并有可用存储空间，再点重试。',
        'Startup checks could not finish. Unlock the device, check available storage and retry.'
      ),
      [{ title: text('重试', 'Retry'), run: () => void start(credentialFailure) }]
    )
  } finally {
    working = false
  }
}
notice(text('正在打开 DeepChat…', 'Opening DeepChat…'))
unsubscribe = subscribeSecurity(() => {
  if (isSecurityUnlocked() && resumeStartup !== null) {
    void start(resumeStartup)
  }
})
void start()
