import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { exportHistory } from '../../services/chat/backup.js'
import {
  buildCheckpointText,
  canCompact,
  compactSession,
  contextPressure,
  shouldWarnContext,
} from '../../services/chat/compact.js'
import type { Session } from '../../services/chat/types.js'
import { updateCheckpointText, useChatStore } from '../../services/chat/store.js'
import { saveBlob } from '../../shell/saveFile.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ContextBanner.module.css'

const RING_SIZE = 30
const RING_RADIUS = 12
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * 上下文额度圆环（仿 DSH）：显示当前用量百分比，点击打开操作面板。
 * 达到 80% 时圆环变橙色，提示压缩；30% 以下不允许压缩。
 */
export const ContextBanner = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const [compacting, setCompacting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [editingSummary, setEditingSummary] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const latest = useChatStore((state) => state.sessionCache[session.id]) ?? session

  const percent = Math.min(100, Math.round(contextPressure(latest) * 100))
  const warn = shouldWarnContext(latest)
  const can = canCompact(latest)
  const stroke = warn ? '#F5A623' : '#426EFE'
  const dash = Math.max(percent, 3)

  const runCompaction = async () => {
    if (compacting) {
      return
    }
    setCompacting(true)
    try {
      const result = await compactSession(latest.id)
      if (result.ok) {
        setConfirmOpen(false)
        setPanelOpen(false)
        showToast({ key: 'contextCompacted', params: { count: result.covered } })
      } else {
        showToast({ key: 'contextCompactFailed', params: { message: result.message.slice(0, 80) } })
      }
    } finally {
      setCompacting(false)
    }
  }

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

  const renderSummary = () => {
    const checkpoint = latest.checkpoint
    if (!checkpoint) {
      return null
    }
    const body = checkpoint.text
      .replace(/^[\s\S]*?<compacted-summary>/, '')
      .replace(/<\/compacted-summary>[\s\S]*$/, '')
      .trim()
    const close = () => {
      setSummaryOpen(false)
      setEditingSummary(false)
    }
    return (
      <Modal
        title={t('contextSummaryTitle')}
        onClose={close}
        footer={
          editingSummary ? (
            <>
              <Button variant="outlined" size="m" onClick={() => setEditingSummary(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                size="m"
                onClick={() => {
                  updateCheckpointText(latest.id, buildCheckpointText(summaryDraft))
                  setEditingSummary(false)
                  showToast({ key: 'contextSummarySaved' })
                }}
              >
                {t('save')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outlined" size="m" onClick={close}>
                {t('close')}
              </Button>
              <Button
                variant="primary"
                size="m"
                onClick={() => {
                  setSummaryDraft(body)
                  setEditingSummary(true)
                }}
              >
                {t('contextSummaryEdit')}
              </Button>
            </>
          )
        }
      >
        <div className={styles.summaryBody}>
          <div className={styles.summaryMeta}>
            {t('contextSummaryMeta', {
              time: new Date(checkpoint.createdAt).toLocaleString(),
              count: checkpoint.coveredMessages,
            })}
          </div>
          {editingSummary ? (
            <>
              <textarea
                className={styles.summaryEditor}
                value={summaryDraft}
                onChange={(event) => setSummaryDraft(event.target.value)}
                spellCheck={false}
              />
              <div className={styles.riskNote}>{t('contextSummaryEditHint')}</div>
            </>
          ) : (
            <div className={styles.summaryText}>{body}</div>
          )}
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

  return (
    <>
      <div className={styles.ringRow}>
        <button
          type="button"
          className={styles.ring}
          aria-label={t('contextUsed', { percent })}
          onClick={() => setPanelOpen(true)}
        >
          <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="var(--ctx-track, #ededed)"
              strokeWidth={2.4}
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke={stroke}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeDasharray={`${(dash / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          </svg>
          <span className={styles.ringText}>{percent}</span>
        </button>
      </div>
      {panelOpen ? (
        <Modal
          title={t('contextPanelTitle')}
          onClose={() => setPanelOpen(false)}
          footer={
            <>
              <Button variant="outlined" size="m" onClick={() => setPanelOpen(false)}>
                {t('close')}
              </Button>
              {can ? (
                <Button
                  variant="primary"
                  size="m"
                  onClick={() => {
                    setPanelOpen(false)
                    setConfirmOpen(true)
                  }}
                >
                  {t('contextCompact')}
                </Button>
              ) : null}
            </>
          }
        >
          <div className={styles.panelBody}>
            <p className={styles.panelPercent}>{t('contextUsed', { percent })}</p>
            <p className={styles.panelHint}>
              {can ? t('contextCompactHint') : t('contextCompactLocked')}
            </p>
            {latest.checkpoint ? (
              <button
                type="button"
                className={styles.backupButton}
                onClick={() => {
                  setPanelOpen(false)
                  setSummaryOpen(true)
                }}
              >
                {t('contextSummaryView')}
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {confirmOpen ? renderConfirm() : null}
      {summaryOpen ? renderSummary() : null}
    </>
  )
}
