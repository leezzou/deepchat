import { useState } from 'react'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { isAnthropicOrigin } from '../../services/api/anthropicOfficial.js'
import {
  profileWindowKey,
  resolveWindow,
  withProfileWindow,
} from '../../services/api/contextOverrides.js'
import { modelEndpoint } from '../../services/api/modelDiscovery.js'
import {
  allowsKeylessLocal,
  endpointProvider,
  nativeModels,
  parseWindow,
} from '../../services/api/modelWindows.js'
import { defaultApiOrigin, normalizeOrigin } from '../../services/api/origin.js'
import { providerLabelsEn, providerPresets } from '../../services/api/providerPresets.js'
import { androidShell } from '../../services/security/bridge.js'
import {
  createApiProfile,
  removeApiProfile,
  saveApiProfile,
  selectApiProfile,
  useSettings,
  type ApiProfile,
} from '../../services/settings.js'
import { openExternal } from '../../shell/native.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconEditOutline16, IconRightUpOutline14 } from '../base/icons.js'
import { ConfirmationModal, Modal, ModalPresence } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { openApiUsage } from './ApiUsage.js'
import { ProviderModelPicker } from './ProviderModelPicker.js'
import { SettingsIcon } from './SettingsIcon.js'
import { SettingsEmpty, SettingsLink, SettingsSection } from './SecondarySettingsView.js'
import { WindowTierChoices } from './WindowTierChoices.js'

const useEnglish = () => useSettings((state) => resolveLocale(state.locale) === 'en-US')

const matchPreset = (profile: ApiProfile) =>
  (profile.providerId && providerPresets.some((item) => item.value === profile.providerId)
    ? profile.providerId
    : undefined) ??
  endpointProvider(normalizeOrigin(profile.origin)) ??
  'custom'

const endpointIdentity = (value: string) => {
  try {
    return modelEndpoint(value).origin
  } catch {
    return ''
  }
}

export function ApiKeyGuide({ onFillKey }: { onFillKey: () => void }) {
  const t = useTranslate()
  const steps = [
    { title: t('apiGuideStep1Title'), body: t('apiGuideStep1Body'), path: 'sign_in' },
    { title: t('apiGuideStep2Title'), body: t('apiGuideStep2Body'), path: 'top_up' },
    { title: t('apiGuideStep3Title'), body: t('apiGuideStep3Body'), path: 'api_keys' },
  ]
  return (
    <div className="secondary-page">
      <SettingsSection title="DeepSeek API">
        <ol className="secondary-guide">
          {steps.map((step, index) => (
            <li key={step.path}>
              <span aria-hidden="true" className="secondary-step">
                {index + 1}
              </span>
              <div>
                <a
                  href={`https://platform.deepseek.com/${step.path}`}
                  onClick={(event) => {
                    event.preventDefault()
                    void openExternal(`https://platform.deepseek.com/${step.path}`)
                  }}
                >
                  {step.title}
                  <IconRightUpOutline14 />
                </a>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </SettingsSection>
      <button type="button" className="secondary-primary" onClick={onFillKey}>
        {t('apiGuideHaveKey')}
      </button>
    </div>
  )
}

export function ApiProfileList({
  onOpenGuide,
  onEdit,
}: {
  onOpenGuide: () => void
  onEdit: (profile: ApiProfile | 'new') => void
}) {
  const t = useTranslate()
  const en = useEnglish()
  const profiles = useSettings((state) => state.apiProfiles)
  const active = useSettings((state) => (state.chatSource === 'api' ? state.activeProfileId : null))
  return (
    <div className="secondary-page">
      <SettingsSection title={en ? 'Saved profiles' : '已存配置'}>
        {!profiles.length && (
          <SettingsEmpty icon="key" title={en ? 'No API profiles yet' : '还没有 API 配置'}>
            {en
              ? 'Connect a provider with your own key.'
              : '添加服务商和密钥，即可使用自己的 API。'}
          </SettingsEmpty>
        )}
        {profiles.map((profile) => (
          <div className="secondary-profile" key={profile.id}>
            <button
              type="button"
              className="secondary-profile-choice"
              aria-pressed={profile.id === active}
              onClick={async () => {
                try {
                  await selectApiProfile(profile.id)
                } catch {
                  showToast({ key: 'credentialWriteFailed' })
                }
              }}
            >
              <span className="secondary-profile-mark">
                {profile.id === active ? <IconCheckOutline16 /> : <SettingsIcon name="key" />}
              </span>
              <span>
                <strong>{profile.name}</strong>
                <small dir="auto">
                  {endpointIdentity(normalizeOrigin(profile.origin)).replace(/^https?:\/\//, '')}
                  {profile.apiKey.length > 4 && ` · ••••${profile.apiKey.slice(-4)}`}
                </small>
              </span>
            </button>
            <button
              type="button"
              className="secondary-edit"
              aria-label={`${t('apiProfileEdit')} · ${profile.name}`}
              onClick={() => onEdit(profile)}
            >
              <IconEditOutline16 />
            </button>
          </div>
        ))}
        <button type="button" className="secondary-add" onClick={() => onEdit('new')}>
          <SettingsIcon name="add" />
          {t('apiProfileAdd')}
        </button>
      </SettingsSection>
      <SettingsSection>
        <SettingsLink icon="guide" onClick={onOpenGuide}>
          {t('apiGuideEntry')}
        </SettingsLink>
        <SettingsLink icon="usage" data-api-usage-entry onClick={openApiUsage}>
          {t('usageTitle')}
        </SettingsLink>
      </SettingsSection>
    </div>
  )
}

type ApiDialog = { view: 'guide' } | { view: 'editor'; profile: ApiProfile; isNew: boolean }

export function DesktopApiProfiles() {
  const t = useTranslate()
  const [dialog, setDialog] = useState<ApiDialog | null>(null)
  const edit = (value: ApiProfile | 'new') =>
    setDialog({
      view: 'editor',
      profile: value === 'new' ? createApiProfile() : value,
      isNew: value === 'new',
    })
  const close = () => setDialog(null)
  return (
    <>
      <ApiProfileList onEdit={edit} onOpenGuide={() => setDialog({ view: 'guide' })} />
      <ModalPresence>
        {dialog && (
          <Modal
            key={dialog.view}
            closable
            className="secondary-api-dialog"
            onClose={close}
            title={t(
              dialog.view === 'guide'
                ? 'apiGuideEntry'
                : dialog.isNew
                  ? 'apiProfileAdd'
                  : 'apiProfileEdit'
            )}
          >
            {dialog.view === 'guide' ? (
              <ApiKeyGuide onFillKey={() => edit('new')} />
            ) : (
              <ApiProfileForm profile={dialog.profile} isNew={dialog.isNew} onDone={close} />
            )}
          </Modal>
        )}
      </ModalPresence>
    </>
  )
}

/** Model discovery is optional: an offline or restricted endpoint can still be configured. */
export const ApiProfileForm = ({
  profile,
  isNew,
  onDone,
}: {
  profile: ApiProfile
  isNew: boolean
  onDone: () => void
}) => {
  const t = useTranslate()
  const english = useEnglish()
  const [preset, setPreset] = useState(() => matchPreset(profile))
  const [name, setName] = useState(profile.name)
  const [protocol, setProtocol] = useState(profile.protocol)
  // 默认地址就不必让人看见，留空即代表官方地址
  const [origin, setOrigin] = useState(profile.origin === defaultApiOrigin ? '' : profile.origin)
  const [model, setModel] = useState(profile.model)
  const [discoveredReasoning, setDiscoveredReasoning] = useState(profile.discoveredReasoning ?? {})
  const [discoveredWindows, setDiscoveredWindows] = useState(profile.discoveredWindows ?? {})
  const [discoveredWindowDetails, setDiscoveredWindowDetails] = useState(
    profile.discoveredWindowDetails ?? {}
  )
  const [discoveredWindowKinds, setDiscoveredWindowKinds] = useState(
    profile.discoveredWindowKinds ?? {}
  )
  const targetModel = model.trim() || 'deepseek-flash'
  const targetOrigin = normalizeOrigin(origin)
  const targetKey = profileWindowKey(targetOrigin, targetModel, protocol)
  const effective = resolveWindow({
    profile: {
      ...profile,
      providerId: preset,
      discoveredWindows,
      discoveredWindowKinds,
      discoveredWindowDetails,
    },
    origin: targetOrigin,
    protocol,
    model: targetModel,
  })
  const [windowDraft, setWindowDraft] = useState<{ key: string; text: string } | null>(null)
  const contextWindow =
    windowDraft?.key === targetKey ? windowDraft.text : String(effective.manual ?? '')
  const invalidWindow = Boolean(contextWindow && !parseWindow(contextWindow))
  const [apiKey, setApiKey] = useState(profile.apiKey)
  const [, catalogReady] = useState(0)
  const [keyCleared, setKeyCleared] = useState(false)
  const endpoint = preset === 'custom' && !origin.trim() ? '' : normalizeOrigin(origin)
  const validEndpoint = Boolean(endpointIdentity(endpoint))
  const canSave =
    validEndpoint &&
    (!isAnthropicOrigin(endpoint) || !!model.trim()) &&
    (Boolean(apiKey.trim()) || allowsKeylessLocal(endpoint, protocol)) &&
    !invalidWindow
  const directoryProvider = endpointProvider(endpoint, preset) ?? 'custom'
  const publicList = [
    'ollama',
    'lmstudio',
    'opencode',
    'opencode-go',
    'openrouter',
    'deepinfra',
  ].includes(directoryProvider)
  const editableProtocol = (id: string) =>
    isAnthropicOrigin(endpoint)
      ? 'anthropic'
      : preset === 'deepseek' && (!id || nativeModels.some((modelId) => id === modelId))
        ? 'deepseek'
        : 'openai'
  const changeOrigin = (next: string) => {
    if (
      apiKey &&
      endpointIdentity(endpoint) !==
        endpointIdentity(next || (preset === 'custom' ? '' : defaultApiOrigin))
    ) {
      setApiKey('')
      setKeyCleared(true)
      setDiscoveredReasoning({})
    }
    setOrigin(next)
    if (isAnthropicOrigin(next)) {
      setProtocol('anthropic')
    } else if (protocol === 'anthropic') {
      setProtocol('openai')
    }
  }
  const pickPreset = (value: string) => {
    const next = providerPresets.find((item) => item.value === value)
    if (!next || value === preset) {
      return
    }
    // Reusing a key across providers, plans or endpoint origins requires re-entry.
    if (apiKey) {
      setKeyCleared(true)
    }
    setApiKey('')
    setDiscoveredReasoning({})
    setPreset(value)
    setName(
      english && /[\u4e00-\u9fff]/u.test(next.name)
        ? (providerLabelsEn[next.value] ?? next.name)
        : next.name
    )
    setProtocol(next.protocol)
    setOrigin(next.origin === defaultApiOrigin ? '' : next.origin)
    setModel(next.protocol === 'deepseek' ? 'deepseek-flash' : next.model)
  }
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const error = failure ? t('credentialWriteFailed') : null

  const submit = async () => {
    const key = apiKey.trim()
    if (!canSave || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      const assembledProfile = {
        ...profile,
        providerId: preset,
        name: name.trim(),
        protocol,
        origin: targetOrigin,
        model: model.trim(),
        discoveredReasoning,
        discoveredWindows,
        discoveredWindowKinds,
        discoveredWindowDetails,
        apiKey: key,
      }
      await saveApiProfile(
        windowDraft?.key === targetKey
          ? withProfileWindow(assembledProfile, targetKey, parseWindow(contextWindow))
          : assembledProfile
      )
      onDone()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <>
      <div className="secondary-page" data-api-editor>
        <SettingsSection title={english ? 'Connection' : '连接'}>
          <div className="secondary-field">
            <div className="secondary-label">{t('apiProfileProvider')}</div>
            <Select
              value={preset}
              options={providerPresets.map((item) => ({
                value: item.value,
                label: english ? (providerLabelsEn[item.value] ?? item.label) : item.label,
              }))}
              onChange={pickPreset}
              ariaLabel={t('apiProfileProvider')}
            />
          </div>
          <div className="secondary-field">
            <label className="secondary-label" htmlFor="api-profile-origin">
              {t('apiProfileOrigin')}
            </label>
            <input
              id="api-profile-origin"
              className="secondary-input"
              value={origin}
              placeholder={preset === 'custom' ? 'https://…/v1' : defaultApiOrigin}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={!!origin.trim() && !validEndpoint}
              aria-describedby={origin.trim() && !validEndpoint ? 'api-origin-hint' : undefined}
              onChange={(event) => changeOrigin(event.target.value)}
            />
            {origin.trim() && !validEndpoint && (
              <p className="secondary-hint" id="api-origin-hint">
                {english
                  ? 'Enter an HTTP or HTTPS URL without credentials, a query or a fragment.'
                  : '填写 HTTP 或 HTTPS 地址，不含账号、查询参数或片段。'}
              </p>
            )}
            {androidShell &&
            /^http:\/\//i.test(endpoint) &&
            !/^http:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2)(?:[:/]|$)/i.test(endpoint) ? (
              <div className="secondary-hint">
                {english
                  ? 'Use HTTPS for this server. Android blocks cleartext LAN requests for both model discovery and chat.'
                  : 'Android 连接局域网服务需要 HTTPS。'}
              </div>
            ) : (
              ['ollama', 'lmstudio'].includes(preset) && (
                <div className="secondary-hint">
                  {english
                    ? 'On Android, localhost means this phone. For a desktop server use its HTTPS address, or 10.0.2.2 in the Android emulator.'
                    : 'localhost 指这台手机。连接电脑请填 HTTPS 地址；模拟器可用 10.0.2.2。'}
                </div>
              )
            )}
          </div>
          <div className="secondary-field">
            <label className="secondary-label" htmlFor="api-profile-key">
              {t('apiProfileKey')}
            </label>
            <input
              id="api-profile-key"
              className="secondary-input"
              type="password"
              value={apiKey}
              placeholder={t('apiKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setKeyCleared(false)
                setApiKey(event.target.value)
                setDiscoveredReasoning({})
                setDiscoveredWindows({})
                setDiscoveredWindowKinds({})
                setDiscoveredWindowDetails({})
              }}
            />
            {keyCleared && (
              <div className="secondary-hint">
                {english
                  ? 'Enter the key for this endpoint.'
                  : '接口已切换，请填写当前接口的密钥。'}
              </div>
            )}
          </div>
        </SettingsSection>
        <SettingsSection title={english ? 'Profile' : '配置'}>
          <div className="secondary-field">
            <label className="secondary-label" htmlFor="api-profile-name">
              {t('apiProfileName')}
            </label>
            <input
              id="api-profile-name"
              className="secondary-input"
              value={name}
              placeholder={t('apiProfileNamePlaceholder')}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="secondary-field">
            <label className="secondary-label" htmlFor="api-profile-model">
              {t('apiProfileModel')}
            </label>
            <ProviderModelPicker
              id="api-profile-model"
              ariaLabel={t('apiProfileModel')}
              providerId={directoryProvider}
              value={model}
              endpoint={endpoint}
              apiKey={apiKey.trim()}
              discover={
                validEndpoint &&
                (Boolean(apiKey.trim()) || publicList || allowsKeylessLocal(endpoint, protocol))
              }
              onCatalogReady={() => catalogReady((n) => n + 1)}
              onChange={(id) => {
                setModel(id)
                setProtocol(editableProtocol(id))
              }}
              onDiscovered={(id, tokens, source, reasoning, details) => {
                const key = profileWindowKey(targetOrigin, id, editableProtocol(id))
                setDiscoveredWindowDetails((prev) => {
                  if (JSON.stringify(prev[key]) === JSON.stringify(details)) {
                    return prev
                  }
                  return details
                    ? { ...prev, [key]: details }
                    : Object.fromEntries(Object.entries(prev).filter(([id]) => id !== key))
                })
                setDiscoveredReasoning((prev) => {
                  if (prev[key] === reasoning) {
                    return prev
                  }
                  if (reasoning) {
                    return { ...prev, [key]: reasoning }
                  }
                  return Object.fromEntries(Object.entries(prev).filter(([entry]) => entry !== key))
                })
                if (tokens === undefined) {
                  const withoutCurrentModel = <T,>(values: Record<string, T>) => {
                    if (!Object.hasOwn(values, key)) {
                      return values
                    }
                    return Object.fromEntries(Object.entries(values).filter(([id]) => id !== key))
                  }
                  setDiscoveredWindowKinds(withoutCurrentModel)
                  setDiscoveredWindows(withoutCurrentModel)
                  return
                }
                setDiscoveredWindowKinds((prev) =>
                  prev[key] === source ? prev : { ...prev, [key]: source }
                )
                setDiscoveredWindows((prev) =>
                  prev[key] === tokens ? prev : { ...prev, [key]: tokens }
                )
              }}
            />
          </div>
          <details className="secondary-options">
            <summary>
              {english ? 'Context window' : '上下文窗口'}
              <span>
                {contextWindow ||
                  Number(effective.inheritedWindow ?? effective.spec.window).toLocaleString(
                    english ? 'en-US' : 'zh-CN'
                  )}
              </span>
            </summary>
            <div className="secondary-field">
              <label className="secondary-label" htmlFor="api-profile-window">
                {t('apiProfileContextWindow')}
              </label>
              <WindowTierChoices
                tiers={effective.spec.tiers}
                en={english}
                selected={contextWindow ? parseWindow(contextWindow) : effective.window}
                onSelect={(n) => setWindowDraft({ key: targetKey, text: String(n) })}
              />
              <input
                id="api-profile-window"
                className="secondary-input"
                value={contextWindow}
                placeholder={
                  effective.spec.basis === 'fallback' && !effective.inheritedWindow
                    ? english
                      ? 'Enter the deployment’s token limit'
                      : '按实际部署填写 token 数'
                    : String(effective.inheritedWindow ?? effective.spec.window)
                }
                aria-invalid={invalidWindow}
                aria-describedby={invalidWindow ? 'api-window-validation' : undefined}
                inputMode="numeric"
                autoComplete="off"
                onChange={(event) => setWindowDraft({ key: targetKey, text: event.target.value })}
              />
            </div>
            {invalidWindow && (
              <div id="api-window-validation" role="alert" className="secondary-error">
                {t('modelContextInvalid')}
              </div>
            )}
          </details>
        </SettingsSection>
        {error && (
          <p role="alert" className="secondary-error">
            {error}
          </p>
        )}
        <div className="secondary-actions secondary-stacked">
          <button
            type="button"
            className="secondary-primary"
            disabled={verifying || !canSave}
            onClick={() => void submit()}
          >
            {verifying ? (english ? 'Saving…' : '正在保存…') : t('apiProfileSave')}
          </button>
          {!isNew && (
            <button
              type="button"
              className="secondary-remove"
              onClick={() => setConfirmDelete(true)}
            >
              {t('apiProfileDelete')}
            </button>
          )}
        </div>
      </div>
      <ModalPresence>
        {confirmDelete ? (
          <ConfirmationModal
            title={t('apiProfileDeleteTitle')}
            onClose={() => setConfirmDelete(false)}
            footer={
              <>
                <Button
                  variant="outlined"
                  size="m"
                  autoFocus
                  onClick={() => setConfirmDelete(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="danger"
                  size="m"
                  onClick={async () => {
                    try {
                      await removeApiProfile(profile.id)
                    } catch {
                      showToast({ key: 'credentialWriteFailed' })
                      return
                    }
                    setConfirmDelete(false)
                    onDone()
                  }}
                >
                  {t('delete')}
                </Button>
              </>
            }
          >
            {t('apiProfileDeleteDescription')}
          </ConfirmationModal>
        ) : null}
      </ModalPresence>
    </>
  )
}
