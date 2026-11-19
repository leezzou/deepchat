import clsx from 'clsx'
import { memo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { FileIcon } from '../files/FileIcon.js'
import {
  formatSize,
  getExtension,
  useUploads,
  type UploadTask,
} from '../../services/attachments.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { FileCard } from '../files/FileCard.js'
import styles from './ChatInput.module.css'

const UPLOADING: UploadTask = { status: 'uploading' }

/** 列表只随草稿附件变化更新；每张卡片独立订阅自己的上传状态。 */
export const DraftAttachments = memo(function DraftAttachments({
  items,
  onRetry,
  onRemove,
}: {
  items: DraftAttachment[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className={styles.attachments} data-horizontal-scroll>
      {items.map((item) => (
        <AttachmentItem
          key={item.id}
          item={item}
          onRetry={() => onRetry(item.id)}
          onRemove={() => onRemove(item.id)}
        />
      ))}
    </div>
  )
})

/** 输入框里的文件：图片显示缩略图，其余显示文件卡片 */
const AttachmentItem = ({
  item,
  onRetry,
  onRemove,
}: {
  item: DraftAttachment
  onRetry: () => void
  onRemove: () => void
}) => {
  const t = useTranslate()
  const mobile = useIsMobile()
  const task = useUploads((state) => state.tasks[item.id] ?? UPLOADING)
  const status = item.localOnly ? 'done' : task.status
  const error = task.status === 'error' ? t(task.error.key, task.error.params) : undefined
  // 过大、格式不支持等重试无效的失败只提示原因，需删除后再发送
  const retry = task.status === 'error' && task.retryable ? onRetry : undefined
  const failed = status === 'error'
  const retryLabel = t('uploadRetry', { message: error ?? t('uploadFileStatusFailed') })
  // 「上传失败」只显示重试图标，其余原因写在图片上：可重试时在图标下方，不可重试时贴底
  const showReason = failed && error !== undefined && error !== t('uploadFileStatusFailed')
  if (mobile) {
    return (
      <div className={styles.mobileFile} data-failed={failed || undefined}>
        <span className={styles.mobileThumb}>
          {item.previewUrl ? (
            <img src={item.previewUrl} alt={item.file.name} />
          ) : (
            <FileIcon ext={getExtension(item.file.name)} />
          )}
        </span>
        <span className={styles.mobileFileMeta}>
          <strong title={item.file.name}>{item.file.name}</strong>
          <small role="status" title={error}>
            {failed
              ? (error ?? t('uploadFileStatusFailed'))
              : status === 'uploading'
                ? t('uploadFileStatusUploading')
                : formatSize(item.file.size)}
          </small>
        </span>
        {retry && (
          <button type="button" aria-label={retryLabel} onClick={retry}>
            <IconRefreshOutline16 />
          </button>
        )}
        <button type="button" aria-label={`${t('delete')} ${item.file.name}`} onClick={onRemove}>
          <IconCloseFill14 />
        </button>
      </div>
    )
  }
  return item.previewUrl ? (
    <div
      className={clsx(styles.attachment, failed && styles.attachmentFailed)}
      title={error ?? item.file.name}
    >
      <img src={item.previewUrl} alt={item.file.name} />
      {status === 'uploading' ? <div className={styles.uploading} /> : null}
      {failed && retry ? (
        <Tooltip content={retryLabel}>
          <button type="button" className={styles.failed} aria-label={retryLabel} onClick={retry}>
            <IconRefreshOutline16 />
            {showReason ? <span className={styles.failedReason}>{error}</span> : null}
          </button>
        </Tooltip>
      ) : null}
      {failed && !retry ? (
        <div className={clsx(styles.failed, styles.failedStatic)} aria-label={error}>
          {showReason ? <span className={styles.failedReason}>{error}</span> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={clsx(styles.remove, failed && !retry && styles.invalidRemove)}
        aria-label={t('delete')}
        onClick={onRemove}
      >
        <IconCloseFill14 />
      </button>
    </div>
  ) : (
    <FileCard
      name={item.file.name}
      size={item.file.size}
      status={status}
      error={error}
      onRetry={retry}
      onRemove={onRemove}
    />
  )
}
