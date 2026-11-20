import { useTranslate } from '../../i18n/index.js'
import { isNative } from '../../shell/native.js'
import { asPlainText } from '../../services/shareImage/plainText.js'
import { IconShareOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import styles from './MessageActions.module.css'

/**
 * 分享一条回复：原生壳走系统分享面板，浏览器走 Web Share API；
 * 都不支持时退回复制到剪贴板。
 */
export const ShareButton = ({ text: markdown }: { text: string }) => {
  const t = useTranslate()

  const share = async () => {
    const text = asPlainText(markdown)
    if (isNative) {
      const { Share } = await import('@capacitor/share')
      await Share.share({ text, dialogTitle: t('share') })
      return
    }
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      await navigator.share({ text })
      return
    }
    if (await copyText(text)) {
      showToast({ key: 'shareCopied' })
    } else {
      showToast({ key: 'copyFailed' })
    }
  }

  return (
    <IconButton
      icon={<IconShareOutline16 />}
      className={styles.action}
      tooltip={t('share')}
      tooltipPlacement="bottom"
      onClick={() => {
        void share().catch(() => showToast({ key: 'shareFailed' }))
      }}
    />
  )
}
