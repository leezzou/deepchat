import { useState } from 'react'
import { resolveLocale } from '../../i18n/index.js'
import { hasAccountBridge } from '../../shell/account.js'
import { getConversationRoute } from '../../services/api/access.js'
import { applyConversationMode, useChatStore } from '../../services/chat/store.js'
import {
  ACCOUNT_PROFILE,
  allTemplates,
  deletePromptTemplate,
  getConversationMode,
  isModelId,
  savePromptTemplate,
  useConversationModes,
  type PromptTemplate,
} from '../../services/conversationMode/storage.js'
import { getSessionMemoryTexts } from '../../services/library/index.js'
import { useLibrarySnapshot } from '../../services/library/useLibrary.js'
import { usePendingEdit } from '../../services/pendingEdits.js'
import { useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { Select } from '../base/Select.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import './conversationControls.css'

const modelName = (id: string) =>
  id === 'deepseek-flash' ? 'DeepSeek Flash' : id === 'deepseek-v4-pro' ? 'DeepSeek Pro' : id
const endpoint = (origin: string) => {
  try {
    const u = new URL(origin, window.location.href)
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return '—'
  }
}
const useEnglish = () => useSettings((s) => resolveLocale(s.locale) === 'en-US')

export function ConversationControls({
  sessionId,
  heading,
}: {
  sessionId: string | null
  heading?: string
}) {
  const [open, setOpen] = useState(false)
  useConversationModes()
  useSettings((s) => s.apiProfiles)
  useSettings((s) => s.activeProfileId)
  useSettings((s) => s.chatSource)
  const en = useEnglish()
  const route = getConversationRoute(sessionId)
  const template = allTemplates().find((t) => t.id === getConversationMode(sessionId).templateId)
  const title = en ? 'Conversation model and template' : '会话模型与模板'
  return (
    <>
      <button
        type="button"
        className="conversation-mode-trigger"
        data-stacked={heading !== undefined || undefined}
        aria-label={`${heading ? `${heading} · ` : ''}${title} · ${modelName(route.model)}${template ? ` · ${template.name}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {heading && <strong title={heading}>{heading}</strong>}
        <span className="conversation-mode-caption">
          <span>
            {route.needsApproval || route.missing
              ? en
                ? 'Review model'
                : '检查模型'
              : modelName(route.model)}
            {template ? ` · ${template.name}` : ''}
          </span>
          <IconChevronDownOutline14 />
        </span>
      </button>
      <ModalPresence>
        {open && <ModePanel key={sessionId} sessionId={sessionId} close={() => setOpen(false)} />}
      </ModalPresence>
    </>
  )
}
function ModePanel({ sessionId, close }: { sessionId: string | null; close: () => void }) {
  const en = useEnglish()
  const mobile = useIsMobile()
  useLibrarySnapshot()
  useConversationModes()
  const profiles = useSettings((s) => s.apiProfiles)
  const busy = useChatStore(
    (s) =>
      s.importingHistory ||
      Boolean(sessionId && (s.streaming[sessionId] || s.compacting[sessionId]))
  )
  const current = getConversationRoute(sessionId)
  const [choice, setChoice] = useState(() => ({
    ...getConversationMode(sessionId),
    profileId: current.profileId ?? undefined,
  }))
  const [editor, setEditor] = useState<PromptTemplate | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const route = getConversationRoute(sessionId, choice)
  const changedProvider = current.destination !== route.destination || current.needsApproval
  const templates = allTemplates()
  const template = templates.find((row) => row.id === choice.templateId)
  const memories = getSessionMemoryTexts(sessionId)
  usePendingEdit(Boolean(editor))
  function save() {
    try {
      if (
        applyConversationMode(sessionId, {
          ...choice,
          model:
            route.protocol === 'deepseek' ? route.nativeModel : choice.model?.trim() || undefined,
          templateId: template?.id,
        })
      ) {
        close()
      }
    } catch {
      setError(en ? 'Could not save on this device. Please try again.' : '未能保存到本机，请重试。')
    }
  }
  const submitTemplate = () => {
    if (!editor) {
      return
    }
    try {
      const id = savePromptTemplate(editor.name, editor.prompt, editor.id || undefined)
      setChoice({ ...choice, templateId: id })
      setEditor(null)
      setError('')
    } catch {
      setError(
        en
          ? 'Could not save this template. Check device storage and try again.'
          : '模板保存失败，请检查本机存储空间后重试。'
      )
    }
  }
  return (
    <Modal
      className="conversation-sheet"
      placement={mobile ? 'bottom' : 'center'}
      title={
        editor
          ? en
            ? 'Edit template'
            : '编辑模板'
          : en
            ? 'Conversation model and template'
            : '会话模型与模板'
      }
      closable
      onClose={editor ? () => setEditor(null) : close}
      footer={
        editor ? (
          <>
            <Button size="m" variant="outlined" onClick={() => setEditor(null)}>
              {en ? 'Cancel' : '取消'}
            </Button>
            <Button
              size="m"
              disabled={!editor.name.trim() || !editor.prompt.trim()}
              onClick={submitTemplate}
            >
              {en ? 'Save template' : '保存模板'}
            </Button>
          </>
        ) : (
          <>
            <Button size="m" variant="outlined" onClick={close}>
              {en ? 'Cancel' : '取消'}
            </Button>
            <Button
              size="m"
              disabled={
                busy ||
                route.missing ||
                deleting ||
                (Boolean(choice.model) && !isModelId(choice.model))
              }
              onClick={save}
            >
              {changedProvider ? (en ? 'Confirm switch' : '确认切换') : en ? 'Apply' : '应用到会话'}
            </Button>
          </>
        )
      }
    >
      <div className="conversation-mode-form">
        {editor ? (
          <>
            <label>
              {en ? 'Template name' : '模板名称'}
              <input
                maxLength={80}
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>
            <label>
              {en ? 'Instructions' : '系统提示词'}
              <textarea
                rows={6}
                maxLength={12000}
                value={editor.prompt}
                onChange={(e) => setEditor({ ...editor, prompt: e.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <div className="conversation-mode-fields">
              <div className="conversation-mode-row">
                <span>{en ? 'Provider' : '服务方案'}</span>
                <Select
                  className="conversation-choice"
                  ariaLabel={en ? 'Provider' : '服务方案'}
                  value={choice.profileId ?? ''}
                  options={[
                    ...(!choice.profileId
                      ? [{ value: '', label: en ? 'Default API' : '默认 API' }]
                      : []),
                    ...(route.missing && choice.profileId
                      ? [{ value: choice.profileId, label: en ? 'Removed provider' : '方案已移除' }]
                      : []),
                    ...(hasAccountBridge || choice.profileId === ACCOUNT_PROFILE
                      ? [
                          {
                            value: ACCOUNT_PROFILE,
                            label: en ? 'DeepSeek account' : 'DeepSeek 账号',
                          },
                        ]
                      : []),
                    ...profiles.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={(value) =>
                    setChoice({ ...choice, profileId: value || undefined, model: undefined })
                  }
                />
              </div>
              <div className="conversation-mode-row">
                <span>{en ? 'Model' : '模型'}</span>
                {route.protocol === 'deepseek' ? (
                  <Select
                    className="conversation-choice"
                    ariaLabel={en ? 'Model' : '模型'}
                    value={route.nativeModel}
                    options={[
                      { value: 'deepseek-flash', label: 'DeepSeek Flash' },
                      { value: 'deepseek-v4-pro', label: 'DeepSeek Pro' },
                    ]}
                    onChange={(model) => setChoice({ ...choice, model })}
                  />
                ) : (
                  <input
                    aria-label={en ? 'Model' : '模型'}
                    value={choice.model ?? ''}
                    maxLength={256}
                    placeholder={route.profile?.model || 'deepseek-flash'}
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(e) => setChoice({ ...choice, model: e.target.value || undefined })}
                  />
                )}
              </div>
            </div>
            {choice.model && !isModelId(choice.model) && (
              <p role="alert">
                {en
                  ? 'Enter a model ID, for example vendor/model.'
                  : '请输入模型 ID，例如 vendor/model。'}
              </p>
            )}
            <p className="conversation-mode-hint">
              {route.protocol === 'openai'
                ? en
                  ? 'Search and thinking switches are unavailable. Attachments require a provider that supports the Files API and file references.'
                  : '此协议无法使用联网搜索与深度思考开关。发送附件需服务商支持文件上传接口及文件引用。'
                : !route.files
                  ? en
                    ? 'This model accepts text only.'
                    : '此模型仅接收文本。'
                  : null}
            </p>
            <div className="conversation-mode-fields">
              <div className="conversation-mode-row">
                <span>{en ? 'Prompt template' : '提示词模板'}</span>
                <Select
                  className="conversation-choice"
                  ariaLabel={en ? 'Prompt template' : '提示词模板'}
                  value={template?.id ?? ''}
                  options={[
                    { value: '', label: en ? 'No template' : '不使用模板' },
                    ...templates.map((row) => ({ value: row.id, label: row.name })),
                  ]}
                  onChange={(value) => {
                    setChoice({ ...choice, templateId: value || undefined })
                    setDeleting(false)
                  }}
                />
              </div>
            </div>
            {template && <p className="conversation-mode-preview">{template.prompt}</p>}
            <div className="conversation-mode-actions">
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  setDeleting(false)
                  setEditor({ id: '', name: '', prompt: '' })
                }}
              >
                {en ? 'New template' : '新建模板'}
              </Button>
              {template && (
                <>
                  <Button
                    variant="outlined"
                    size="s"
                    onClick={() => {
                      setDeleting(false)
                      setEditor({ ...template })
                    }}
                  >
                    {en ? 'Edit' : '编辑'}
                  </Button>
                  <Button variant="dangerOutlined" size="s" onClick={() => setDeleting(true)}>
                    {en ? 'Delete' : '删除'}
                  </Button>
                </>
              )}
            </div>
            {deleting && template && (
              <div role="alert" className="conversation-mode-note">
                {en
                  ? 'Remove this template from every conversation?'
                  : '删除此模板，并从使用它的会话中取消选用？'}
                <div className="conversation-mode-actions">
                  <Button variant="outlined" size="s" onClick={() => setDeleting(false)}>
                    {en ? 'Keep' : '保留'}
                  </Button>
                  <Button
                    variant="danger"
                    size="s"
                    onClick={() => {
                      try {
                        deletePromptTemplate(template.id)
                        setChoice({ ...choice, templateId: undefined })
                        setDeleting(false)
                      } catch {
                        showToast(en ? 'Deletion failed' : '删除失败')
                      }
                    }}
                  >
                    {en ? 'Delete template' : '删除模板'}
                  </Button>
                </div>
              </div>
            )}
            {memories.length > 0 && (
              <details className="conversation-mode-memories">
                <summary>
                  {en ? 'Included memories' : '随请求发送的记忆'} · {memories.length}
                </summary>
                <ul>
                  {memories.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="conversation-mode-note" role={changedProvider ? 'alert' : undefined}>
              {changedProvider
                ? en
                  ? 'After switching, the next message will send the selected history, attachments, template and enabled memories to'
                  : '确认切换后，下次发送会把选中的历史上下文、附件、模板和已启用记忆交给'
                : en
                  ? 'Request destination'
                  : '请求将发送至'}{' '}
              <strong>
                {route.account && en
                  ? 'DeepSeek account'
                  : !route.profile && !route.missing && en
                    ? 'Default API'
                    : route.name}
              </strong>
              <small>{endpoint(route.origin)}</small>
            </div>
            {busy && (
              <p role="status">
                {en
                  ? 'Wait for the current request to finish before applying changes.'
                  : '当前请求结束后可应用新的会话设置。'}
              </p>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
