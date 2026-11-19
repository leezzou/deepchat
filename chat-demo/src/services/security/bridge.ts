type Port = { postMessage(text: string): void; onmessage?: (message: MessageEvent<string>) => void }
const host =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & {
        DeepChatSecurity?: Port
        AndroidSystemBars?: object
        Capacitor?: { getPlatform?: () => string }
      })
const port = host?.DeepChatSecurity
export const androidShell = !!(
  port ||
  host?.AndroidSystemBars ||
  host?.Capacitor?.getPlatform?.() === 'android'
)
export const hasSecurityPort = !!port
export type SecurityState = {
  enabled: boolean
  unlocked: boolean
  available: boolean
  vault: boolean
}
let state: SecurityState = {
  enabled: false,
  unlocked: !androidShell,
  available: false,
  vault: false,
}
export const securityState = () => state
export const isSecurityUnlocked = () => state.unlocked
const publish = (next: SecurityState) => {
  state = next
  window.dispatchEvent(new Event('deepchat:security-change'))
}
export const subscribeSecurity = (listener: () => void) => {
  window.addEventListener('deepchat:security-change', listener)
  return () => window.removeEventListener('deepchat:security-change', listener)
}
let sequence = 0
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }>()
if (port) {
  port.onmessage = ({ data }) => {
    const frame = JSON.parse(data)
    if (frame.state) {
      publish(frame.state)
      return
    }
    const waiter = pending.get(frame.id)
    if (!waiter) {
      return
    }
    pending.delete(frame.id)
    if (frame.error) {
      waiter.reject(new Error(String(frame.error)))
    } else {
      waiter.resolve(frame.value)
    }
  }
}
async function call<T>(op: string, fields: object = {}): Promise<T> {
  if (!port) {
    throw new Error('unavailable')
  }
  const id = String(++sequence)
  return await new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => {
        pending.delete(id)
        reject(new Error('timeout'))
      },
      op === 'configure' ? 180_000 : 20_000
    )
    pending.set(id, {
      resolve: (value) => {
        window.clearTimeout(timer)
        resolve(value as T)
      },
      reject: (e) => {
        window.clearTimeout(timer)
        reject(e)
      },
    })
    try {
      port.postMessage(JSON.stringify({ id, op, ...fields }))
    } catch {
      pending.delete(id)
      window.clearTimeout(timer)
      reject(new Error('unavailable'))
    }
  })
}
export async function refreshSecurity() {
  if (port) {
    publish(await call<SecurityState>('status'))
  }
}
export function syncLockAppearance(theme: 'system' | 'light' | 'dark', locale: 'system' | 'en-US' | 'zh-CN') {
  if (port && isSecurityUnlocked()) {
    void call('appearance', { theme, locale }).catch(() => {})
  }
}
export async function configureLock(enabled: boolean) {
  publish(await call<SecurityState>('configure', { enabled }))
}
export const nativeProfileVault = {
  read: () => call<string | null>('read'),
  write: (value: string) => call<boolean>('write', { value }),
}
