import { useTranslate } from '../../i18n/index.js'
import {
  describeReadAloudError,
  toggleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { getConversationRoute } from '../../services/api/access.js'
import { useConversationModes } from '../../services/conversationMode/storage.js'
import { useSettings } from '../../services/settings.js'
import { IconPlayMediaOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ReadingBars } from './ReadingBars.js'
import styles from './MessageActions.module.css'

/** 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止；正文原样提交，由服务端过滤 markdown */
export const ReadAloudButton = ({
  sessionId,
  messageId,
  text,
}: {
  sessionId: string
  messageId: string
  text: string
}) => {
  const t = useTranslate()
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  useConversationModes((state) => state.data)
  useSettings((state) => state.chatSource)
  useSettings((state) => state.activeProfileId)
  useSettings((state) => state.apiProfiles)
  if (status === 'idle' && !getConversationRoute(sessionId).speech) {
    return null
  }
  return (
    <IconButton
      icon={status === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={status} />}
      className={styles.action}
      tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      onClick={() =>
        toggleReadAloud(
          messageId,
          text,
          (error) => showToast(describeReadAloudError(error)),
          sessionId
        )
      }
    />
  )
}
