import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isOpenAiFiles, type FileInputMode } from '../../services/api/fileCapabilities.js'
import { isAnthropicOrigin } from '../../services/api/anthropicOfficial.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { IconPaperclipOutline16, IconPlusCircle24 } from '../base/icons.js'
import styles from './ChatInput.module.css'

export function FilePickerButton({
  mode,
  mobile,
  english,
  disabled,
  origin,
  choose,
}: {
  mode: FileInputMode
  mobile: boolean
  english: boolean
  disabled: boolean
  origin: string
  choose: (kind: 'text' | 'upload') => void
}) {
  const [open, setOpen] = useState(false)
  const t = useTranslate()
  const label =
    mode === 'text'
      ? t('inlineFileAction')
      : mode === 'upload'
        ? t('uploadFile')
        : english
          ? 'Add a file'
          : '添加文件'
  const pick = (kind: 'text' | 'upload') => {
    setOpen(false)
    if (!disabled) {
      choose(kind)
    }
  }
  return (
    <>
      <IconButton
        size="m"
        tone="primary"
        icon={mobile ? <IconPlusCircle24 /> : <IconPaperclipOutline16 />}
        tooltip={label}
        aria-haspopup={mode === 'choice' ? 'dialog' : undefined}
        onClick={() => (mode === 'choice' ? setOpen(true) : pick(mode))}
        disabled={disabled}
      />
      <ModalPresence>
        {open && mode === 'choice' && (
          <Modal
            title={label}
            closable
            placement={mobile ? 'bottom' : 'center'}
            onClose={() => setOpen(false)}
          >
            <div className={styles.fileOptions}>
              <Button variant="outlined" block onClick={() => pick('text')}>
                {t('inlineFileAction')}
              </Button>
              <small>
                {english
                  ? 'Review the text in your draft before sending.'
                  : '在输入框预览并编辑正文，再点击发送。'}
              </small>
              <Button variant="outlined" block onClick={() => pick('upload')}>
                {english ? 'Upload original' : '上传原件'}
              </Button>
              <small>
                {isOpenAiFiles(origin)
                  ? t('uploadPdfOnly')
                  : isAnthropicOrigin(origin)
                    ? t('uploadClaudeTypes')
                    : english
                      ? 'Uploads the file to this endpoint when selected. The endpoint and model must both support file IDs.'
                      : '选中即把原件上传到当前端点，需服务商支持文件接口且模型支持文件编号。'}
              </small>
            </div>
          </Modal>
        )}
      </ModalPresence>
    </>
  )
}
