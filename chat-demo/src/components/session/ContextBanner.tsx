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
  const [backingUp, setBackingUp] = useState(false)
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
      {confirmOpen ? (
        <Modal
          title={t('contextRiskTitle')}
          onClose={() => (compacting ? undefined : setConfirmOpen(false))}
          footer={
            <>
              <Button variant="outlined" size="m" onClick={() => setConfirmOpen(false)}>
                {t('cancel')}
              </Button>
              <Button variant="dangerOutlined" size="m" disabled={compacting} onClick={() => void runCompaction()}>
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
      ) : null}
    </>
  )
}
