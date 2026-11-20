import { useEffect, useRef, useState } from 'react'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  openBackup,
  PortableError,
  sealBackup,
  type BackupProblem,
} from '../../services/backup/portableCrypto.js'
import {
  getEncryptedBackup,
  putEncryptedBackup,
  testDavConnection,
} from '../../services/backup/webDav.js'
import {
  BackupError,
  SnapshotError,
  exportPortableHistory,
  restorePortableHistory,
} from '../../services/chat/backup.js'
import { importFailure } from './importFeedback.js'
import { PostCommitRecoveryError } from '../../services/backup/portableMetadata.js'
import { ConfirmationModal, ModalPresence } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import './securitySettings.css'
import './dataBackup.css'

const problems: Record<BackupProblem, [string, string]> = {
  address: [
    '请输入已有目录的 HTTPS 地址，账号和密码请分开填写。',
    'Enter an existing HTTPS folder URL, with credentials in their own fields.',
  ],
  credentials: [
    '账号或密码无效，或账号没有目录读写权限。',
    'Check the username, password and folder permissions.',
  ],
  network: [
    '连接中断。请检查网络、证书和地址。浏览器还需要服务器允许跨域访问。',
    'Connection failed. Check the network, certificate and folder URL. Browsers also need server CORS support.',
  ],
  missing: [
    '目录或远端备份不存在。请检查目录，或先创建备份。',
    'Folder or backup not found. Check the folder, or create a backup first.',
  ],
  server: [
    '服务器未完成请求。请检查 WebDAV 目录的读写权限。',
    'The server could not complete the request. Check WebDAV folder permissions.',
  ],
  password: [
    '请使用 10 至 1024 个字符的独立备份密码。',
    'Use a separate backup password of 10–1024 characters.',
  ],
  decrypt: [
    '备份密码不正确，或文件已损坏。本机数据已保留。',
    'Incorrect backup password or damaged file. Your local data is intact.',
  ],
  format: [
    '无法识别备份格式。本机数据已保留。',
    'Unsupported backup format. Your local data is intact.',
  ],
  large: [
    '加密备份超过 32 MiB，请使用本地历史导出。',
    'Encrypted backups support up to 32 MiB. Use local history export for larger archives.',
  ],
  unavailable: [
    '当前环境不支持安全备份。请使用新版应用或 HTTPS 浏览器。',
    'Secure backup is unavailable. Use an up-to-date app or HTTPS browser.',
  ],
  local: [
    '无法完成本地操作。请检查存储空间，然后重试。',
    'Local operation failed. Check available storage and try again.',
  ],
}
type Action = 'test' | 'backup' | 'restore'

export function WebDavSettings() {
  const lang = useSettings((s) => resolveLocale(s.locale)) === 'zh-CN' ? 0 : 1
  const t = (zh: string, en: string) => (lang === 0 ? zh : en)
  const translate = useTranslate()
  const [folder, setFolder] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState(false)
  const [operation, setOperation] = useState<Action | null>(null)
  const validPhrase = phrase.length >= 10 && phrase.length <= 1024
  const mounted = useRef(true)
  const running = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = async (action: Action) => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    setOperation(action)
    setConfirm(false)
    setError(false)
    const account = { folder, username, password }
    try {
      if (action === 'test') {
        setStatus(t('正在测试目录读写…', 'Testing folder access…'))
        await testDavConnection(account)
        if (mounted.current) {
          setStatus(t('连接成功，目录可读写。', 'Connected. Folder read and write verified.'))
        }
      } else if (action === 'backup') {
        if (phrase.length < 10) {
          throw new PortableError('password')
        }
        setStatus(t('正在本机生成并加密备份…', 'Creating and encrypting backup locally…'))
        const { zip, metadata } = await exportPortableHistory()
        const sealed = await sealBackup(zip, metadata, phrase)
        if (!mounted.current) {
          return
        }
        setStatus(t('正在上传加密文件…', 'Uploading encrypted file…'))
        await putEncryptedBackup(account, sealed)
        if (mounted.current) {
          setStatus(
            t(
              '加密备份已上传。换机恢复时请使用相同密码。',
              'Encrypted backup uploaded. Use the same password on your other device.'
            )
          )
        }
      } else {
        setStatus(t('正在下载并校验备份…', 'Downloading and verifying backup…'))
        const { file, metadata } = await openBackup(await getEncryptedBackup(account), phrase)
        if (!mounted.current) {
          return
        }
        setStatus(t('正在保存本机快照并恢复…', 'Saving a local recovery point and restoring…'))
        const count = await restorePortableHistory(file, metadata, () => mounted.current)
        if (mounted.current) {
          setStatus(
            t(
              `已恢复 ${count} 个会话，可在本机安全快照中撤销。`,
              `Restored ${count} conversations. Use the local safety snapshot to undo.`
            )
          )
        }
      }
    } catch (reason) {
      if (mounted.current) {
        setError(true)
        if (reason instanceof PostCommitRecoveryError) {
          setStatus(translate('importRecoveryPending'))
        } else if (action === 'restore' && !(reason instanceof PortableError)) {
          const stage = reason instanceof SnapshotError ? 'snapshot' : 'commit'
          const { failure } = importFailure(
            stage,
            reason,
            reason instanceof BackupError ? reason.key : undefined
          )
          setStatus(`${translate(failure.reason, failure.params)} ${translate(failure.action)}`)
        } else {
          setStatus(problems[reason instanceof PortableError ? reason.problem : 'local'][lang])
        }
      }
    } finally {
      running.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  const field = (
    label: string,
    value: string,
    set: (text: string) => void,
    type = 'text',
    placeholder = '',
    describedBy?: string
  ) => (
    <label className="dav-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        aria-describedby={describedBy}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={busy}
        onChange={(event) => {
          set(event.target.value)
          setStatus('')
          setConfirm(false)
        }}
      />
    </label>
  )
  const feedback = (
    <div
      role={error ? 'alert' : 'status'}
      className={error ? 'dav-status dav-error' : 'dav-status'}
    >
      {status}
    </div>
  )
  return (
    <div className="dav-settings history-dav">
      <section className="dav-section" aria-labelledby="dav-server">
        <h2 id="dav-server">{t('服务器连接', 'Server connection')}</h2>
        <div className="history-dav-card">
          {field(
            t('WebDAV 目录地址', 'WebDAV folder URL'),
            folder,
            setFolder,
            'url',
            'https://example.org/dav/'
          )}
          {field(t('用户名', 'Username'), username, setUsername)}
          {field(t('WebDAV 密码', 'WebDAV password'), password, setPassword, 'password')}
          <div>
            <Button
              variant="outlined"
              disabled={busy || !folder.trim()}
              onClick={() => void run('test')}
            >
              {t('测试连接', 'Test connection')}
            </Button>
          </div>
          {operation === 'test' && feedback}
        </div>
      </section>
      <section className="dav-section" aria-labelledby="dav-backup">
        <h2 id="dav-backup">{t('备份与恢复', 'Backup and restore')}</h2>
        <div className="history-dav-card">
          {field(
            t('备份密码', 'Backup password'),
            phrase,
            setPhrase,
            'password',
            '',
            'dav-phrase-hint'
          )}
          <p id="dav-phrase-hint">
            {t(
              '使用 10–1024 个字符的独立密码，恢复时需要。',
              'Use a separate password of 10–1024 characters. Keep it for recovery.'
            )}
          </p>
          <details className="history-dav-info">
            <summary>{t('备份包含哪些数据', 'What’s included in a backup')}</summary>
            <p>
              {t(
                '包含历史会话、图片、文件夹、收藏、模板及记忆。登录凭据、API Key 和草稿仅留在本机。',
                'Includes conversations, images, folders, favorites, templates and memories. Credentials, API keys and drafts stay on this device.'
              )}
            </p>
          </details>
          <p>
            {t(
              '上传会替换目录中的 deepchat-backup.dcb，最大 32 MiB。',
              'Uploads replace deepchat-backup.dcb in this folder. Limit 32 MiB.'
            )}
          </p>
          <div className="dav-actions">
            <Button
              disabled={busy || !folder.trim() || !validPhrase}
              onClick={() => void run('backup')}
            >
              {t('加密并备份', 'Encrypt and back up')}
            </Button>
            <Button
              variant="outlined"
              disabled={busy || !folder.trim() || !phrase || phrase.length > 1024}
              onClick={() => setConfirm(true)}
            >
              {t('从备份恢复', 'Restore from backup')}
            </Button>
          </div>
          <ModalPresence>
            {confirm && (
              <ConfirmationModal
                title={t('确认恢复', 'Confirm restore')}
                onClose={() => setConfirm(false)}
                footer={
                  <>
                    <Button variant="outlined" autoFocus onClick={() => setConfirm(false)}>
                      {t('取消', 'Cancel')}
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => void run('restore')}>
                      {t('确认恢复', 'Confirm restore')}
                    </Button>
                  </>
                }
              >
                <p>
                  {t(
                    '恢复会替换本机会话、草稿及相关资料。替换前将保存本机安全快照。',
                    'Restoring replaces local conversations, drafts and related data. A local recovery point is saved first.'
                  )}
                </p>
              </ConfirmationModal>
            )}
          </ModalPresence>
          {operation !== 'test' && feedback}
        </div>
      </section>
    </div>
  )
}
