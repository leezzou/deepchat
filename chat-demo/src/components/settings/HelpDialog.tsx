import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { copyText } from '../../utils/clipboard.js'
import { IconCopyOutline16 } from '../base/icons.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SettingsIcon, type SettingsIconName } from './SettingsIcon.js'
import './settingsHelp.css'

const SUPPORT_EMAIL = 'leezzou@mail.ustc.edu.cn'

export function HelpDialog({
  open,
  onClose,
  mobile = false,
}: {
  open: boolean
  onClose: () => void
  mobile?: boolean
}) {
  const t = useTranslate()
  const en = useSettings((s) => resolveLocale(s.locale) === 'en-US')
  const topics: { icon: SettingsIconName; title: string; text: string }[] = [
    {
      icon: 'key',
      title: en ? 'Use an API key' : '使用自己的 API Key',
      text: en
        ? 'In Settings, open API keys and add your provider and key.'
        : '在设置中打开「API Key 管理」，添加服务商和密钥。',
    },
    {
      icon: 'download',
      title: en ? 'Back up chats' : '备份聊天',
      text: en
        ? 'Export a ZIP in Data management. Import it to restore your conversations.'
        : '在「数据管理」导出 ZIP。需要恢复对话时，再导入这份文件。',
    },
    {
      icon: 'data',
      title: en ? 'Recover cleared chats' : '找回已清空的对话',
      text: t('backupHelpClear'),
    },
  ]
  return (
    <ModalPresence>
      {open && (
        <Modal
          title={t('settingsHelp')}
          closable
          placement={mobile ? 'bottom' : 'center'}
          onClose={onClose}
        >
          <div className="settings-help">
            {topics.map(({ icon, title, text }) => (
              <details key={icon}>
                <summary>
                  <SettingsIcon name={icon} compact />
                  <span>{title}</span>
                  <span className="settings-help-chevron" aria-hidden="true" />
                </summary>
                <p>{text}</p>
              </details>
            ))}
            <div className="settings-help-contact">
              <div>
                <span>{en ? 'Feedback email' : '反馈邮箱'}</span>
                <address>{SUPPORT_EMAIL}</address>
              </div>
              <button
                type="button"
                aria-label={en ? 'Copy email address' : '复制邮箱地址'}
                onClick={async () => {
                  const copied = await copyText(SUPPORT_EMAIL)
                  showToast(
                    copied
                      ? en
                        ? 'Email address copied'
                        : '已复制邮箱地址'
                      : { key: 'copyFailed' }
                  )
                }}
              >
                <IconCopyOutline16 />
              </button>
            </div>
          </div>
        </Modal>
      )}
    </ModalPresence>
  )
}
