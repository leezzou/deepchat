import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { exportHistory } from '../../services/chat/backup.js'
import { compactSession, contextPressure, shouldWarnContext } from '../../services/chat/compact.js'
import type { Session } from '../../services/chat/types.js'
import { useChatStore } from '../../services/chat/store.js'
import { saveBlob } from '../../shell/saveFile.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ContextBanner.module.css'

/**
 * 上下文即将超限时提示用户，并给一个「压缩上下文」入口。
 * 压缩方式与 DSH 一致：把较早轮次压成结构化 checkpoint，保留最近约 16%。
 * 压缩会丢弃旧消息原文、只留摘要——对聊天用户是不可逆的信息损失，所以先弹风险确认。
 */
export const ContextBanner = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const [compacting, setCompacting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  // 订阅会话变化，压缩完检查点写入后横幅自然消失
  const latest = useChatStore((state) => state.sessionCache[session.id]) ?? session
  const percent = Math.min(99, Math.round(contextPressure(latest) * 100))
  const runCompaction = async () => {
    if (compacting) {
      return
    }
    setCompacting(true)
    try {
      const result = await compactSession(latest.id)
      if (result.ok) {
        setConfirmOpen(false)
        showToast({ key: 'contextCompacted', params: { count: result.covered } })
      } else {
        showToast({ key: 'contextCompactFailed', params: { message: result.message.slice(0, 80) } })
      }
    } finally {
      setCompacting(false)
    }
  }

  /** 压缩前建议先备份：导出全部历史对话为 ZIP */
  const backupFirst = async () => {
    if (backingUp) {
      return
    }
    setBackingUp(true)
    try {
      const { name, blob } = await exportHistory()
      await saveBlob(name, blob)
      showToast({ key: 'contextBackupDone' })
    } catch {
      showToast({ key: 'historyExportFailed', params: { message: '' } })
    } finally {
      setBackingUp(false)
    }
  }

  /** 展示压缩后的摘要原文（去掉内部的 preamble 与标签，只留正文） */
  const renderSummary = () => {
    const checkpoint = latest.checkpoint
    if (!checkpoint) {
      return null
    }
    const body = checkpoint.text
      .replace(/^[\s\S]*?<compacted-summary>/, '')
      .replace(/<\/compacted-summary>[\s\S]*$/, '')
      .trim()
    return (
      <Modal
        title={t('contextSummaryTitle')}
        onClose={() => setSummaryOpen(false)}
        footer={
          <Button variant="outlined" size="m" onClick={() => setSummaryOpen(false)}>
            {t('close')}
          </Button>
        }
      >
        <div className={styles.summaryBody}>
          <div className={styles.summaryMeta}>
            {t('contextSummaryMeta', {
              time: new Date(checkpoint.createdAt).toLocaleString(),
              count: checkpoint.coveredMessages,
            })}
          </div>
          <div className={styles.summaryText}>{body}</div>
        </div>
      </Modal>
    )
  }

  const renderConfirm = () => (
    <Modal
      title={t('contextRiskTitle')}
      onClose={() => (compacting ? undefined : setConfirmOpen(false))}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={() => setConfirmOpen(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="m"
            disabled={compacting}
            onClick={() => void runCompaction()}
          >
            {compacting ? t('contextCompacting') : t('contextRiskConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.riskBody}>
        <p className={styles.riskIntro}>{t('contextRiskIntro')}</p>
        <ul className={styles.riskList}>
          <li>{t('contextRiskItem1')}</li>
          <li>{t('contextRiskItem2')}</li>
          <li>{t('contextRiskItem3')}</li>
          <li>{t('contextRiskItem4')}</li>
        </ul>
        <p className={styles.riskNote}>{t('contextRiskNote')}</p>
        <button
          type="button"
          className={styles.backupButton}
          disabled={backingUp}
          onClick={() => void backupFirst()}
        >
          {backingUp ? t('contextBackingUp') : t('contextRiskBackup')}
        </button>
      </div>
    </Modal>
  )

  if (!shouldWarnContext(latest)) {
    // 没到阈值也给一行常驻的用量条，随时可以手动压缩（方便测试/主动整理）
    return (
      <div className={styles.meter}>
        {latest.checkpoint ? (
          <>
            <button
              type="button"
              className={styles.meterAction}
              onClick={() => setSummaryOpen(true)}
            >
              {t('contextCompactedLabel')}
            </button>
            <span>·</span>
          </>
        ) : null}
        <span>{t('contextUsed', { percent })}</span>
        <button type="button" className={styles.meterAction} onClick={() => setConfirmOpen(true)}>
          {t('contextCompact')}
        </button>
        {confirmOpen ? renderConfirm() : null}
        {summaryOpen ? renderSummary() : null}
      </div>
    )
  }

  return (
    <>
      <div className={styles.banner} role="status">
        <div className={styles.text}>
          <div className={styles.title}>{t('contextAlmostFull', { percent })}</div>
          <div className={styles.hint}>{t('contextCompactHint')}</div>
        </div>
        <button type="button" className={styles.action} onClick={() => setConfirmOpen(true)}>
          {t('contextCompact')}
        </button>
      </div>
      {latest.checkpoint ? (
        <button type="button" className={styles.meterAction} onClick={() => setSummaryOpen(true)}>
          {t('contextSummaryView')}
        </button>
      ) : null}
      {confirmOpen ? renderConfirm() : null}
      {summaryOpen ? renderSummary() : null}
    </>
  )
}
