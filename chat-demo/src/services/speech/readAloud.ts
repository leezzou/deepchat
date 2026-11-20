import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, TTS_SAMPLE_RATE } from '../api/speech.js'
import { requireChatAccess, type ChatAccess } from '../api/access.js'
import { useSettings } from '../settings.js'
import { MAX_READ_CHARS, speakLocally } from './deviceVoice.js'
import { speechIdentity, speechLanguage, speechMode, subscribeSpeechRoute } from './speechRoute.js'

export type ReadAloudStatus = 'idle' | 'loading' | 'playing'
export const useReadAloud = create<{ messageId: string | null; status: ReadAloudStatus }>(() => ({
  messageId: null,
  status: 'idle',
}))
let current: AbortController | null = null

export const stopReadAloud = () => {
  if (!current) {
    return
  }
  current.abort()
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
}

/** Schedule bounded 24 kHz mono PCM buffers. Keep an odd trailing byte for the next packet. */
async function playOfficial(
  access: ChatAccess,
  text: string,
  signal: AbortSignal,
  playing: () => void
) {
  const context = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  const close = () => {
    if (context.state !== 'closed') {
      void context.close().catch(() => {})
    }
  }
  signal.addEventListener('abort', close, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Resume synchronously from the click when possible. An autoplay block must not leave the button spinning.
    if (context.state === 'suspended') {
      await Promise.race([
        context.resume(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('audio-blocked')), 2500)
        }),
      ])
    }
    if (signal.aborted) {
      return
    }
    const stream = await synthesize(access, text, useSettings.getState().ttsVoice, signal)
    const reader = stream.getReader()
    const cancel = () => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      let nextTime = 0,
        received = 0,
        carry = -1
      let lastEnd: Promise<void> | undefined
      for (;;) {
        if (signal.aborted) {
          return
        }
        const { done, value } = await reader.read()
        if (done || signal.aborted) {
          break
        }
        if (!value.length) {
          continue
        }
        received += value.length
        if (received > 2 * TTS_SAMPLE_RATE * 600) {
          throw new Error('audio-limit')
        }
        const bytes = carry < 0 ? value : new Uint8Array(value.length + 1)
        if (carry >= 0) {
          bytes[0] = carry
          bytes.set(value, 1)
        }
        carry = bytes.length % 2 === 0 ? -1 : bytes[bytes.length - 1]
        const count = bytes.length >> 1
        if (!count) {
          continue
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
        const buffer = context.createBuffer(1, count, TTS_SAMPLE_RATE)
        const samples = buffer.getChannelData(0)
        for (let i = 0; i < count; ++i) {
          samples[i] = view.getInt16(i * 2, true) / 0x8000
        }
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        nextTime = Math.max(nextTime, context.currentTime + (lastEnd ? 0 : 0.1))
        lastEnd = new Promise<void>((resolve) => {
          source.onended = () => resolve()
        })
        source.start(nextTime)
        nextTime += buffer.duration
        playing()
      }
      if (!lastEnd && !signal.aborted) {
        throw new Error('no-audio')
      }
      if (lastEnd && !signal.aborted) {
        await Promise.race([
          lastEnd,
          new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true })
          ),
        ])
      }
    } finally {
      cancel()
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', close)
    close()
  }
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof Error && error.message === 'offline-voice') {
    return { key: 'ttsOfflineUnavailable' }
  }
  if (error instanceof Error && error.message === 'too-long') {
    return { key: 'ttsTooLong' }
  }
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.localMessage ?? error.message
  }
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

export function toggleReadAloud(
  messageId: string,
  text: string,
  onError: (error: unknown) => void,
  sessionId?: string
) {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const mode = speechMode(sessionId, 'tts')
  if (mode === 'blocked' || mode === 'unavailable') {
    onError(new Error('offline-voice'))
    return
  }
  if (text.length > MAX_READ_CHARS) {
    onError(new Error('too-long'))
    return
  }
  const controller = new AbortController()
  current = controller
  useReadAloud.setState({ messageId, status: 'loading' })
  const identity = speechIdentity(sessionId)
  const unsubscribe = subscribeSpeechRoute(() => {
    if (identity !== speechIdentity(sessionId)) {
      stopReadAloud()
    }
  })
  const hidden = () => {
    if (document.hidden) {
      stopReadAloud()
    }
  }
  document.addEventListener('visibilitychange', hidden)
  const timeout = setTimeout(() => {
    if (current === controller) {
      stopReadAloud()
      onError(new Error('timeout'))
    }
  }, 600_000)
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timeout)
      unsubscribe()
      document.removeEventListener('visibilitychange', hidden)
    },
    { once: true }
  )
  const playing = () => {
    if (current === controller && useReadAloud.getState().status === 'loading') {
      useReadAloud.setState({ status: 'playing' })
    }
  }
  void (async () => {
    try {
      if (mode === 'official') {
        await playOfficial(requireChatAccess(sessionId), text, controller.signal, playing)
      } else {
        await speakLocally(text, speechLanguage(), controller.signal, playing)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        onError(error)
      }
    } finally {
      if (current === controller) {
        stopReadAloud()
      }
    }
  })()
}
