import { Capacitor, registerPlugin } from '@capacitor/core'
import { create } from 'zustand'

export type VoiceLanguage = 'zh-CN' | 'en-US'
type Options = { lang: VoiceLanguage }
type Availability = { available: boolean }
type DeviceVoice = {
  voiceAvailable(options: Options): Promise<Availability>
  recognitionAvailable(options: Options): Promise<Availability>
  speak(options: Options & { text: string; id: string }): Promise<void>
  cancelSpeech(options: { id: string }): Promise<void>
  requestPermissions(options: { permissions: string[] }): Promise<{ microphone: string }>
  recognize(options: Options & { id: string }): Promise<{ text: string }>
  endRecognition(options: { id: string; cancel: boolean }): Promise<void>
}
const native = registerPlugin<DeviceVoice>('DeviceVoice')
const hasNative = () => Capacitor.isPluginAvailable('DeviceVoice')

type Capabilities = { lang: VoiceLanguage | null; tts: boolean; asr: boolean }
export const useDeviceVoice = create<Capabilities>(() => ({ lang: null, tts: false, asr: false }))

export function webLocalVoice(lang: VoiceLanguage) {
  const voices = window.speechSynthesis?.getVoices().filter((v) => v.localService === true) ?? []
  return (
    voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
    voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === lang.slice(0, 2))
  )
}

// No ordinary SpeechRecognition fallback: implementations may upload the microphone stream.
type WebRecognition = {
  lang: string
  processLocally: boolean
  onresult:
    | ((event: { results: { [key: number]: { [key: number]: { transcript: string } } } }) => void)
    | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}
type WebRecognizer = {
  new (): WebRecognition
  available?(options: { langs: string[]; processLocally: true }): Promise<string>
}
const webRecognizer = () =>
  (window as Window & { SpeechRecognition?: WebRecognizer }).SpeechRecognition

// The foreground composer owns this probe. Other controls only subscribe to its snapshot.
export function observeDeviceVoice(lang: VoiceLanguage) {
  let alive = true
  let ticket = 0
  useDeviceVoice.setState({ lang, tts: false, asr: false })
  const refresh = () => {
    const query = ++ticket
    const publish = (key: 'tts' | 'asr', value: boolean) => {
      if (alive && query === ticket) {
        useDeviceVoice.setState({ [key]: value })
      }
    }
    if (hasNative()) {
      void native.voiceAvailable({ lang }).then(
        (r) => publish('tts', r.available),
        () => publish('tts', false)
      )
      void native.recognitionAvailable({ lang }).then(
        (r) => publish('asr', r.available),
        () => publish('asr', false)
      )
    } else {
      try {
        publish('tts', !!webLocalVoice(lang) && typeof SpeechSynthesisUtterance === 'function')
      } catch {
        publish('tts', false)
      }
      const ctor = webRecognizer()
      if (ctor?.available && 'processLocally' in ctor.prototype) {
        void ctor.available({ langs: [lang], processLocally: true }).then(
          (v) => publish('asr', v === 'available'),
          () => publish('asr', false)
        )
      } else {
        publish('asr', false)
      }
    }
  }
  refresh()
  window.addEventListener('focus', refresh)
  window.speechSynthesis?.addEventListener('voiceschanged', refresh)
  return () => {
    alive = false
    window.removeEventListener('focus', refresh)
    window.speechSynthesis?.removeEventListener('voiceschanged', refresh)
    useDeviceVoice.setState({ lang: null, tts: false, asr: false })
  }
}

// Split sequentially (never enqueue an entire chat). Avoid a cut between surrogate halves.
export const MAX_READ_CHARS = 16_000
export function* voiceChunks(text: string) {
  for (let pos = 0; pos < text.length; ) {
    let end = Math.min(text.length, pos + 240)
    if (end < text.length) {
      const boundary = /[，。！？、；,.!?;\s](?=[^，。！？、；,.!?;\s]*$)/.exec(
        text.slice(pos, end)
      )
      if (boundary && boundary.index >= 80) {
        end = pos + boundary.index + 1
      }
      if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end--
      }
    }
    yield text.slice(pos, end)
    pos = end
  }
}

let sequence = 0
const nextId = () => `${Date.now()}-${++sequence}`
export async function speakLocally(
  text: string,
  lang: VoiceLanguage,
  signal: AbortSignal,
  playing: () => void
) {
  if (text.length > MAX_READ_CHARS) {
    throw new Error('too-long')
  }
  for (const chunk of voiceChunks(text)) {
    if (signal.aborted) {
      return
    }
    const id = nextId()
    await new Promise<void>((resolve, reject) => {
      const useNative = hasNative()
      let utterance: SpeechSynthesisUtterance | undefined
      const done = (error?: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (utterance) {
          utterance.onstart = utterance.onend = utterance.onerror = null
        }
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const cancel = () => {
        if (useNative) {
          void native.cancelSpeech({ id }).catch(() => {})
        } else if (utterance) {
          window.speechSynthesis.cancel()
        }
        done(new Error('cancelled'))
      }
      const timer = setTimeout(cancel, 60_000)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (useNative) {
          playing()
          void native.speak({ lang, id, text: chunk }).then(
            () => done(),
            () => done(new Error('offline-voice'))
          )
        } else {
          const voice = webLocalVoice(lang)
          if (!voice) {
            throw new Error('offline-voice')
          }
          utterance = new SpeechSynthesisUtterance(chunk)
          utterance.lang = voice.lang
          utterance.voice = voice
          utterance.onstart = playing
          utterance.onend = () => done()
          utterance.onerror = () => done(new Error('offline-voice'))
          window.speechSynthesis.speak(utterance)
        }
      } catch (error) {
        done(error)
      }
    })
  }
}

export function recognizeLocally(lang: VoiceLanguage) {
  const id = nextId()
  let cancelled = false
  let stop = () => {
    cancelled = true
  }
  let abort = stop
  const result = (async () => {
    if (hasNative()) {
      const permission = await native.requestPermissions({ permissions: ['microphone'] })
      if (cancelled) {
        throw new Error('cancelled')
      }
      if (permission.microphone !== 'granted') {
        throw new DOMException('microphone', 'NotAllowedError')
      }
      stop = () => {
        void native.endRecognition({ id, cancel: false }).catch(() => {})
      }
      abort = () => {
        void native.endRecognition({ id, cancel: true }).catch(() => {})
      }
      return (await native.recognize({ lang, id })).text
    }
    const Ctor = webRecognizer()
    if (
      !Ctor?.available ||
      !('processLocally' in Ctor.prototype) ||
      (await Ctor.available({ langs: [lang], processLocally: true })) !== 'available' ||
      cancelled
    ) {
      throw new Error('offline-recognizer')
    }
    const engine = new Ctor()
    engine.processLocally = true
    if (engine.processLocally !== true) {
      throw new Error('offline-recognizer')
    }
    engine.lang = lang
    return new Promise<string>((resolve, reject) => {
      stop = () => engine.stop()
      abort = () => {
        engine.abort()
        reject(new Error('cancelled'))
      }
      engine.onresult = (e) => resolve(e.results[0]?.[0]?.transcript ?? '')
      engine.onerror = (e) =>
        e.error === 'no-speech'
          ? resolve('')
          : reject(
              e.error === 'not-allowed'
                ? new DOMException('microphone', 'NotAllowedError')
                : new Error('offline-recognizer')
            )
      engine.onend = () => resolve('')
      engine.start()
    })
  })()
  return {
    result,
    finish: () => stop(),
    cancel: () => {
      cancelled = true
      abort()
    },
  }
}
