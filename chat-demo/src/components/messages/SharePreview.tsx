import { useEffect, useMemo, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import '../library/localSwitch.css'
import { resolveLocale } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import type { Message } from '../../services/chat/types.js'
import { asMarkdown, shareEntry } from '../../services/shareImage/content.js'
import { renderShareImages } from '../../services/shareImage/render.js'
import { saveBlob } from '../../shell/saveFile.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import './messageTools.css'

export const useEnglish = () => useSettings((s) => resolveLocale(s.locale) === 'en-US')

export const SharePreview = ({
  messages,
  onClose,
}: {
  messages: Message[]
  onClose: () => void
}) => {
  const en = useEnglish()
  const mobile = useIsMobile()
  const entries = useMemo(() => messages.map(shareEntry), [messages])
  const [includeThinking, setThinking] = useState(false)
  const [includeNames, setNames] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const doc = useMemo(
    () => ({
      title: en ? 'Conversation excerpt' : '对话摘录',
      thoughtLabel: en ? 'Thinking' : '思考过程',
      sections: entries.map((entry) => ({
        role: entry.role === 'user' ? (en ? 'You' : '我') : en ? 'Assistant' : '助手',
        body:
          entry.body || (!entry.files.length ? (en ? '(No answer text)' : '（无回复正文）') : ''),
        plainBody: entry.role === 'user',
        imageBody: entry.imageBody,
        citationIndices: entry.citationIndices,
        thinking: includeThinking ? entry.thinking : '',
        attachments: entry.files.length
          ? includeNames
            ? entry.files.join(' · ')
            : en
              ? `Attachments: ${entry.files.length}`
              : `附件 ${entry.files.length} 个`
          : '',
      })),
    }),
    [en, entries, includeThinking, includeNames]
  )
  const [result, setResult] = useState<{ doc: typeof doc; blobs: Blob[]; urls: string[] } | null>(
    null
  )
  const [error, setError] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let urls: string[] = []
    setError(false)
    setResult(null)
    const start = window.setTimeout(() => {
      void renderShareImages(doc, abort.signal)
        .then((blobs) => {
          if (!abort.signal.aborted) {
            urls = blobs.map((blob) => URL.createObjectURL(blob))
            setResult({ doc, blobs, urls })
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setError(true)
          }
        })
    }, 40)
    return () => {
      clearTimeout(start)
      abort.abort()
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [doc, attempt])
  const ready = result?.doc === doc ? result : null
  const multiple = (ready?.blobs.length ?? 0) > 1
  const save = async (markdown: boolean) => {
    if (busy || (!markdown && !ready)) {
      return
    }
    setBusy(true)
    try {
      const name = `DeepChat-${Date.now()}`
      let blob: Blob
      let extension: string
      if (markdown) {
        blob = new Blob([asMarkdown(doc)], { type: 'text/markdown;charset=utf-8' })
        extension = 'md'
      } else if (ready && ready.blobs.length > 1) {
        const { zipSync } = await import('fflate')
        const files: Record<string, Uint8Array> = {}
        for (const [index, image] of ready.blobs.entries()) {
          files[`${name}-${String(index + 1).padStart(4, '0')}.png`] = new Uint8Array(
            await image.arrayBuffer()
          )
        }
        blob = new Blob([new Uint8Array(zipSync(files, { level: 0 }))], { type: 'application/zip' })
        extension = 'zip'
      } else if (ready) {
        blob = ready.blobs[0]
        extension = 'png'
      } else {
        return
      }
      const { status } = await saveBlob(`${name}.${extension}`, blob)
      showToast(
        status === 'shared'
          ? en
            ? 'Sent to the system share sheet'
            : '已交给系统分享'
          : en
            ? 'Download requested'
            : '已发起下载'
      )
    } catch (err) {
      if (!/cancel|abort/i.test(String(err))) {
        showToast({ key: 'shareFailed' })
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={en ? 'Share preview' : '分享预览'}
      placement={mobile ? 'bottom' : 'center'}
      closable
      onClose={onClose}
      className="dc-share-preview"
      footer={
        <>
          <Button size="m" variant="outlined" disabled={busy} onClick={() => void save(true)}>
            {en ? 'Export Markdown' : '导出 Markdown'}
          </Button>
          <Button size="m" disabled={busy || !ready} onClick={() => void save(false)}>
            {busy
              ? en
                ? 'Preparing…'
                : '处理中…'
              : multiple
                ? en
                  ? 'Export ZIP'
                  : '导出图片包'
                : en
                  ? 'Export image'
                  : '导出长图'}
          </Button>
        </>
      }
    >
      <div className="dc-share-settings">
        <p className="dc-preview-count">
          {en
            ? `${entries.length} ${entries.length === 1 ? 'message' : 'messages'} selected`
            : `已选 ${entries.length} 条消息`}
        </p>
        {entries.some((entry) => entry.thinking) && (
          <label>
            {en ? 'Include thinking' : '包含思考过程'}
            <input
              className="dc-local-switch"
              type="checkbox"
              role="switch"
              checked={includeThinking}
              disabled={busy}
              onChange={(e) => setThinking(e.target.checked)}
            />
          </label>
        )}
        {entries.some((entry) => entry.files.length) && (
          <label>
            {en ? 'Show attachment names' : '显示附件名'}
            <input
              className="dc-local-switch"
              type="checkbox"
              role="switch"
              checked={includeNames}
              disabled={busy}
              onChange={(e) => setNames(e.target.checked)}
            />
          </label>
        )}
      </div>
      <div className="dc-preview-canvas" aria-busy={!ready && !error}>
        {ready ? (
          <>
            {multiple && (
              <p role="status">
                {en
                  ? `Split into ${ready.blobs.length} images to keep the text readable.`
                  : `内容较长，已分为 ${ready.blobs.length} 张，按顺序保存。`}
              </p>
            )}
            {ready.urls.map((url, index) => (
              <img
                key={url}
                className="dc-share-image"
                src={url}
                loading={index ? 'lazy' : 'eager'}
                alt={en ? `Share image ${index + 1}` : `对话长图 ${index + 1}`}
              />
            ))}
          </>
        ) : error ? (
          <p role="alert">
            {en ? 'Image could not be generated.' : '图片未能生成。'}{' '}
            <Button size="m" variant="outlined" onClick={() => setAttempt((a) => a + 1)}>
              {en ? 'Retry' : '重试'}
            </Button>
          </p>
        ) : (
          <p role="status">{en ? 'Laying out the image…' : '正在排版长图…'}</p>
        )}
      </div>
    </Modal>
  )
}
