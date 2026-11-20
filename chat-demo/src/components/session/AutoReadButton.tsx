import { useTranslate } from '../../i18n/index.js'
import { setAutoRead, useSettings } from '../../services/settings.js'
import { useSpeechMode } from '../../services/speech/speechRoute.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconSpeakerWaves24, IconSpeakerWavesOff24 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'

export function AutoReadButton({
  sessionId,
  mobile,
}: {
  sessionId: string | null
  mobile?: boolean
}) {
  const t = useTranslate()
  const enabled = useSettings((state) => state.autoRead)
  const mode = useSpeechMode(sessionId, 'tts')
  const available = mode === 'device' || mode === 'official'
  const active = available && enabled
  const label = t(
    mode === 'blocked'
      ? 'voiceRouteUnavailable'
      : mode === 'unavailable'
        ? 'ttsOfflineUnavailable'
        : mode === 'device'
          ? 'autoReadLocal'
          : 'autoReadOfficial'
  )
  return (
    <IconButton
      size={mobile ? 'xl' : 'm'}
      tone={available ? 'primary' : 'tertiary'}
      icon={active ? <IconSpeakerWaves24 /> : <IconSpeakerWavesOff24 />}
      aria-label={`${t('autoReadAloud')} · ${label}`}
      tooltip={label}
      aria-pressed={active}
      aria-disabled={!available}
      onClick={() => {
        if (!available) {
          showToast(label)
          return
        }
        setAutoRead(!enabled)
        if (enabled) {
          stopReadAloud()
        }
      }}
    />
  )
}
