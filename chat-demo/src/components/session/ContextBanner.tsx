import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { compactSession, contextPressure, shouldWarnContext } from '../../services/chat/compact.js'
import type { Session } from '../../services/chat/types.js'
import { useChatStore } from '../../services/chat/store.js'
import { showToast } from '../base/toastState.js'
import styles from './ContextBanner.module.css'

/**
 * 上下文即将超限时提示用户，并给一个「压缩上下文」入口。
 * 压缩方式与 DSH 一致：把较早轮次压成结构化 checkpoint，保留最近约 16%。
 */
export const ContextBanner = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const [compacting, setCompacting] = useState(false)
  // 订阅会话变化，压缩完检查点写入后横幅自然消失
  const latest = useChatStore((state) => state.sessionCache[session.id]) ?? session
  if (!shouldWarnContext(latest)) {
    // 已经压缩过的会话给一行轻提示，避免用户以为消息丢了
    return latest.checkpoint ? (
      <div className={styles.compacted}>{t('contextCompactedLabel')}</div>
    ) : null
  }
  const percent = Math.min(99, Math.round(contextPressure(latest) * 100))

  const runCompaction = async () => {
    if (compacting) {
      return
    }
    setCompacting(true)
    try {
      const result = await compactSession(latest.id)
      if (result.ok) {
        showToast({ key: 'contextCompacted', params: { count: result.covered } })
      } else {
        showToast({ key: 'contextCompactFailed', params: { message: result.message.slice(0, 80) } })
      }
    } finally {
      setCompacting(false)
    }
  }

  return (
    <div className={styles.banner} role="status">
      <div className={styles.text}>
        <div className={styles.title}>{t('contextAlmostFull', { percent })}</div>
        <div className={styles.hint}>{t('contextCompactHint')}</div>
      </div>
      <button
        type="button"
        className={styles.action}
        disabled={compacting}
        onClick={() => void runCompaction()}
      >
        {compacting ? t('contextCompacting') : t('contextCompact')}
      </button>
    </div>
  )
}
