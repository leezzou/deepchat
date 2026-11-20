import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationKey, TranslationMessage } from '../../i18n/index.js'
import { transcribe } from '../../services/api/speech.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import {
  getConversationRoute,
  requireChatAccess,
  type ChatAccess,
} from '../../services/api/access.js'
import { observeDeviceVoice, recognizeLocally } from '../../services/speech/deviceVoice.js'
import {
  speechIdentity,
  speechLanguage,
  speechMode,
  subscribeSpeechRoute,
  useSpeechMode,
} from '../../services/speech/speechRoute.js'
import { useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

const describeRecordingError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'voiceInputFailed' }
}

type Operation = {
  identity: string
  controller: AbortController
  source?: ChatAccess
  recording?: Recording
  local?: ReturnType<typeof recognizeLocally>
  timer?: ReturnType<typeof setTimeout>
}

export const useVoiceInput = (sessionId: string | null, onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const active = useRef<Operation | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const mode = useSpeechMode(sessionId, 'asr')
  const locale = useSettings((state) => state.locale)
  const localRoute = !getConversationRoute(sessionId).speech
  useEffect(
    () => (localRoute ? observeDeviceVoice(speechLanguage()) : undefined),
    [locale, localRoute]
  )

  const release = useCallback(() => {
    const op = active.current
    active.current = null
    if (!op) {
      return
    }
    clearTimeout(op.timer)
    op.controller.abort()
    op.recording?.cancel()
    op.local?.cancel()
  }, [])
  const cancel = useCallback(() => {
    release()
    setStatus('idle')
  }, [release])

  useEffect(() => {
    const unsubscribe = subscribeSpeechRoute(() => {
      if (active.current && active.current.identity !== speechIdentity(sessionId)) {
        cancel()
      }
    })
    const onHidden = () => {
      if (document.hidden) {
        cancel()
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onHidden)
      release()
    }
  }, [sessionId, release, cancel])

  const deliver = (op: Operation, text: string) => {
    if (active.current !== op || op.identity !== speechIdentity(sessionId)) {
      return
    }
    if (text.trim()) {
      onTextRef.current(text.trim())
    } else {
      showToast({ key: 'voiceInputEmpty' })
    }
  }
  const deadline = (op: Operation, ms: number) => {
    clearTimeout(op.timer)
    op.timer = setTimeout(() => {
      if (active.current !== op) {
        return
      }
      cancel()
      showToast({ key: 'voiceInputFailed' })
    }, ms)
  }
  const finish = async (op: Operation) => {
    if (active.current !== op) {
      return
    }
    if (!op.recording && !op.local) {
      cancel()
      return
    }
    setStatus('transcribing')
    deadline(op, op.local ? 8000 : 60_000)
    if (op.local) {
      op.local.finish()
      return
    }
    try {
      const audio = await op.recording?.stop()
      if (active.current !== op || !audio || !op.source) {
        return
      }
      if (
        op.identity !== speechIdentity(sessionId) ||
        speechMode(sessionId, 'asr') !== 'official' ||
        JSON.stringify(op.source) !== JSON.stringify(requireChatAccess(sessionId))
      ) {
        return
      }
      deliver(op, await transcribe(op.source, audio, op.controller.signal))
    } catch (error) {
      if (active.current === op) {
        showToast(describeRecordingError(error))
      }
    } finally {
      if (active.current === op) {
        cancel()
      }
    }
  }
  const available =
    mode === 'device' ||
    (mode === 'official' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia)
  const label: TranslationKey =
    mode === 'device'
      ? 'voiceOfflineInput'
      : mode === 'official'
        ? available
          ? 'voiceInput'
          : window.isSecureContext
            ? 'voiceInputNoDevice'
            : 'voiceInputRequiresHttps'
        : mode === 'blocked'
          ? 'voiceRouteUnavailable'
          : 'voiceOfflineUnavailable'
  const toggle = async () => {
    const prior = active.current
    if (prior) {
      if (status === 'recording') {
        await finish(prior)
      } else {
        cancel()
      }
      return
    }
    if (!available || mode !== speechMode(sessionId, 'asr')) {
      return
    }
    const op: Operation = { identity: speechIdentity(sessionId), controller: new AbortController() }
    active.current = op
    setSeconds(0)
    setStatus('recording')
    deadline(op, 125_000)
    try {
      if (mode === 'device') {
        op.local = recognizeLocally(speechLanguage())
        deliver(op, await op.local.result)
        if (active.current === op) {
          cancel()
        }
      } else {
        op.source = requireChatAccess(sessionId)
        const recording = await startRecording(() => {
          if (active.current === op) {
            showToast({ key: 'voiceInputLimitReached' })
            void finish(op)
          }
        })
        if (active.current === op) {
          op.recording = recording
        } else {
          recording.cancel()
        }
      }
    } catch (error) {
      if (active.current === op) {
        cancel()
        showToast(describeRecordingError(error))
      }
    }
  }
  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500)
    return () => clearInterval(timer)
  }, [status])
  const getAnalyser = useCallback(() => active.current?.recording?.analyser ?? null, [])
  return {
    status,
    seconds,
    getAnalyser,
    toggle,
    cancel,
    available,
    label,
    local: mode === 'device',
  }
}
