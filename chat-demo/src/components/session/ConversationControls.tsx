import { useState } from 'react'
import type { DiscoveredModel } from '../../services/api/modelDiscovery.js'
import { reasoningWire } from '../../services/api/providerParity.js'
import { retrievalSources } from '../../services/api/searchConsent.js'
import { searchCapability } from '../../services/api/searchCapabilities.js'
import { resolveLocale } from '../../i18n/index.js'
import { hasAccountBridge } from '../../shell/account.js'
import { getConversationRoute } from '../../services/api/access.js'
import { applyConversationMode, useChatStore } from '../../services/chat/store.js'
import {
  ACCOUNT_PROFILE,
  allTemplates,
  deletePromptTemplate,
  getConversationMode,
  savePromptTemplate,
  useConversationModes,
  type PromptTemplate,
} from '../../services/conversationMode/storage.js'
import { getSessionMemoryTexts } from '../../services/library/index.js'
import { useLibrarySnapshot } from '../../services/library/useLibrary.js'
import { usePendingEdit } from '../../services/pendingEdits.js'
import { useSettings } from '../../services/settings.js'
import { useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { WORKBUDDY_PROFILE } from '../../services/workbuddy/models.js'
import { useIsMobile } from '../../app/viewport.js'
import { Select } from '../base/Select.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { ConfirmationModal, Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import './conversationControls.css'

const endpoint = (origin: string) => {
  try {
    const u = new URL(origin, window.location.href)
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return '—'
  }
}
const useEnglish = () => useSettings((s) => resolveLocale(s.locale) === 'en-US')

type PanelRoute = ReturnType<typeof getConversationRoute>
function CapabilityHint({
  route,
  en,
  reasoning,
}: {
  route: PanelRoute
  en: boolean
  reasoning?: DiscoveredModel['reasoning']
}) {
  if (route.missing) {
    return null
  }
  const tr = (zh: string, english: string) => (en ? english : zh)
  const wb = route.profileId === WORKBUDDY_PROFILE
  const toggle = wb
    ? route.thinking
    : Boolean(
        reasoningWire({
          protocol: route.protocol,
          origin: route.origin,
          model: route.model,
          providerId: route.profile?.providerId,
          reasoningSupport: reasoning ?? route.reasoningSupport,
        })
      )
  const search = wb ? 'workbuddy' : searchCapability(route.origin, route.protocol, route.model)
  return (
    <div className="conversation-mode-hint" data-mode-capabilities>
      <p>
        {(reasoning ?? route.reasoningSupport) === 'none'
          ? tr('此部署未提供思考功能。', 'This deployment reports no reasoning support.')
          : route.reasoningDisplayOnly && (!reasoning || reasoning === 'fixed')
            ? tr(
                '可显示模型返回的思考，推理计算由模型控制。',
                'Show reasoning returned by the model. The model controls the computation.'
              )
            : toggle
              ? tr('可切换深度思考。', 'Thinking can be toggled.')
              : (reasoning ?? route.reasoningSupport) === 'fixed'
                ? tr('此模型自动控制思考。', 'This model controls its own reasoning.')
                : tr(
                    '此部署未提供可用的思考开关。',
                    'No thinking switch is available for this deployment.'
                  )}{' '}
        {wb
          ? tr(
              '联网搜索使用 WorkBuddy 账号，费用与模型权限取决于套餐。',
              'Search uses your WorkBuddy account. Model access and charges depend on your plan.'
            )
          : search === 'none'
            ? retrievalSources().length
              ? tr(
                  '可在输入框选择检索服务并确认本次检索词。',
                  'Choose a search service in the composer and confirm the terms for this reply.'
                )
              : tr(
                  '尚未配置可用的联网搜索服务。',
                  'No search service is configured for this route.'
                )
            : tr(
                '输入框提供当前服务商的联网搜索选项。',
                'Provider web search is available in the composer.'
              )}
      </p>
      <p>
        {route.fileInput === 'text'
          ? tr(
              '可插入 TXT 或 Markdown 正文，预览后随消息发送。',
              'Insert TXT or Markdown text and review it before sending.'
            )
          : route.fileInput === 'choice'
            ? tr(
                '可插入文本，也可上传原件；上传需服务商支持文件引用。',
                'Insert text or upload originals when the provider supports file references.'
              )
            : tr(
                '可上传原件并在对话中引用。',
                'Upload original files and reference them in the conversation.'
              )}
      </p>
    </div>
  )
}

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
  useWorkBuddyState((s) => s.metadata)
  const en = useEnglish()
  const route = getConversationRoute(sessionId)
  const template = allTemplates().find((t) => t.id === getConversationMode(sessionId).templateId)
  const title = en ? 'Conversation settings' : '会话设置'
  return (
    <>
      <button
        type="button"
        className="conversation-mode-trigger"
        data-stacked={heading !== undefined || undefined}
        aria-label={`${heading ? `${heading} · ` : ''}${title}${template ? ` · ${template.name}` : ''}`}
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
              : (template?.name ?? (en ? 'Conversation settings' : '会话设置'))}
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
export function ModePanel({ sessionId, close }: { sessionId: string | null; close: () => void }) {
  const en = useEnglish()
  const mobile = useIsMobile()
  useLibrarySnapshot()
  useConversationModes()
  const profiles = useSettings((s) => s.apiProfiles)
  const workBuddy = useWorkBuddyState((s) => s.metadata)
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
  function selectProvider(value: string) {
    setChoice({ ...choice, profileId: value || undefined, model: undefined })
  }
  const changedProvider = current.destination !== route.destination || current.needsApproval
  const templates = allTemplates()
  const template = templates.find((row) => row.id === choice.templateId)
  const memories = getSessionMemoryTexts(sessionId)
  usePendingEdit(Boolean(editor))
  function save() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    try {
      if (
        applyConversationMode(sessionId, {
          ...choice,
          model: choice.model?.trim() || undefined,
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
        editor ? (en ? 'Edit template' : '编辑模板') : en ? 'Conversation settings' : '会话设置'
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
            <Button size="m" disabled={busy || route.missing || deleting} onClick={save}>
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
                    ...(route.missing &&
                    choice.profileId &&
                    !(choice.profileId === WORKBUDDY_PROFILE && workBuddy)
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
                    ...(workBuddy ? [{ value: WORKBUDDY_PROFILE, label: 'WorkBuddy' }] : []),
                    ...profiles.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={selectProvider}
                />
              </div>
            </div>
            <CapabilityHint en={en} route={route} />
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
            <ModalPresence>
              {deleting && template && (
                <ConfirmationModal
                  title={en ? 'Delete template?' : '删除模板？'}
                  onClose={() => setDeleting(false)}
                  footer={
                    <>
                      <Button variant="outlined" onClick={() => setDeleting(false)}>
                        {en ? 'Cancel' : '取消'}
                      </Button>
                      <Button
                        variant="danger"
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
                    </>
                  }
                >
                  {en
                    ? `“${template.name}” will be removed from every chat that uses it.`
                    : `删除后，所有选用「${template.name}」的对话都会取消选用该模板。`}
                </ConfirmationModal>
              )}
            </ModalPresence>
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
