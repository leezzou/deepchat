import { useEffect, useId, useState } from 'react'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import {
  endpointProvider,
  nativeModels,
  parseWindow,
  warmModelWindows,
  type WindowSpec,
} from '../../services/api/modelWindows.js'
import {
  resolveWindow,
  saveBuiltinWindow,
  useWindowOverrides,
  type ContextTarget,
} from '../../services/api/contextOverrides.js'
import { providerLabelsEn, providerPresets } from '../../services/api/providerPresets.js'
import { isModelId } from '../../services/conversationMode/storage.js'
import { saveProfileDiscovery, saveProfileWindow, useSettings } from '../../services/settings.js'
import { useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { openExternal } from '../../shell/native.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { WindowTierChoices } from './WindowTierChoices.js'
import { ProviderModelPicker } from './ProviderModelPicker.js'
import { workBuddyModelOption } from './WorkBuddyModelPicker.js'
import styles from './ContextModelSettings.module.css'

const basisText: Record<WindowSpec['basis'], [string, string]> = {
  bundled: [
    'WorkBuddy 内置渠道配置的输入预算',
    'Input budget from the WorkBuddy client configuration',
  ],
  provider: ['服务商公布的窗口', 'Published provider window'],
  discovered: ['此部署返回的窗口', 'Window reported by this deployment'],
  catalog: ['模型目录记录的窗口', 'Window from the model catalog'],
  model: [
    '上游模型规格，当前渠道上限待确认',
    'Upstream model window. The channel limit is unconfirmed.',
  ],
  variable: [
    '默认预算，实际窗口随部署或账号而变',
    'Default budget. The available window depends on the deployment or account.',
  ],
  historical: [
    '原型号公布的窗口，当前可用性请查阅服务商文档',
    'Historical model window. Check provider documentation for current availability.',
  ],
  input: ['按服务商公布的输入上限规划预算', 'Budget based on the published input limit'],
  fallback: [
    '尚无此部署的窗口数据，使用应用的临时预算',
    'No verified deployment limit. Using an app fallback budget.',
  ],
}
export function ContextModelSettings() {
  const en = useSettings((s) => resolveLocale(s.locale) === 'en-US')
  const profiles = useSettings((s) => s.apiProfiles)
  const revision = useSettings((s) => s.accountRevision)
  const wb = useWorkBuddyState((s) => s.metadata)
  const wbRows = useWorkBuddyState((s) => s.models)
  const wbCached = useWorkBuddyState((s) => s.catalogStale)
  const [selected, setSelected] = useState('account')
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  const profile = profiles.find((p) => `profile:${p.id}` === selected)
  const preset = providerPresets.find((p) => `preset:${p.value}` === selected)
  const channel =
    selected === 'workbuddy' ? 'workbuddy' : selected === 'account' ? 'account' : undefined
  const provider =
    channel === 'workbuddy'
      ? 'workbuddy'
      : channel === 'account'
        ? 'deepseek'
        : preset?.value || endpointProvider(profile?.origin ?? '', profile?.providerId)
  const [, setReady] = useState(0)
  useEffect(() => {
    let current = true
    warmModelWindows(provider)?.then(() => {
      if (current) {
        setReady((n) => n + 1)
      }
    })
    return () => {
      current = false
    }
  }, [provider])
  const native = channel === 'account' || profile?.protocol === 'deepseek'
  const wbModels = wbRows.map((row) => row.id)
  const defaultModel =
    channel === 'workbuddy' ? (wb?.model ?? '') : profile?.model || preset?.model || nativeModels[0]
  const options = [
    { value: 'account', label: en ? 'DeepSeek account' : 'DeepSeek 账号' },
    { value: 'workbuddy', label: 'WorkBuddy' },
    ...profiles.map((p) => ({ value: `profile:${p.id}`, label: p.name })),
    ...providerPresets
      .filter((p) => p.value !== 'custom')
      .map((p) => ({
        value: `preset:${p.value}`,
        label: en ? (providerLabelsEn[p.value] ?? p.label) : p.label,
      })),
  ]
  const model = chosenModel ?? defaultModel
  const target: ContextTarget = {
    provider,
    channel,
    profile,
    model,
    grant: channel === 'workbuddy' ? wb?.revision : (revision ?? undefined),
  }
  const providerLabel = en ? 'Provider' : '服务方案'
  const modelLabel = en ? 'Model' : '模型'
  const valid = isModelId(model) && (channel !== 'workbuddy' || wbModels.includes(model))
  return (
    <section data-context-settings className={styles.settings}>
      <div className={styles.field}>
        <span>{providerLabel}</span>
        <Select
          value={selected}
          ariaLabel={providerLabel}
          options={options}
          onChange={(value) => {
            setSelected(value)
            setChosenModel(null)
          }}
        />
      </div>
      <div className={styles.field}>
        <span>{modelLabel}</span>
        {native || channel === 'workbuddy' ? (
          <Select
            value={model}
            ariaLabel={modelLabel}
            onChange={setChosenModel}
            placeholder={
              channel === 'workbuddy' && model
                ? `${model} · ${en ? 'Unavailable' : '当前不可选'}`
                : undefined
            }
            options={
              native
                ? nativeModels.map((id) => ({ value: id, label: id }))
                : wbRows.map((row) => workBuddyModelOption(row, en, wbCached))
            }
          />
        ) : (
          <ProviderModelPicker
            key={selected}
            endpoint={profile?.origin}
            apiKey={profile?.apiKey}
            discover={Boolean(profile)}
            onDiscovered={(id, contextWindow, source, reasoning, windowDetails) => {
              if (profile) {
                void saveProfileDiscovery(profile, {
                  id,
                  name: id,
                  contextWindow,
                  source,
                  reasoning,
                  windowDetails,
                }).catch(() => {})
              }
            }}
            providerId={provider ?? 'custom'}
            value={model}
            onChange={setChosenModel}
            ariaLabel={modelLabel}
          />
        )}
      </div>
      <WindowEditor
        key={JSON.stringify([selected, model, target.grant])}
        target={target}
        valid={valid}
        en={en}
      />
    </section>
  )
}
function WindowEditor({
  target,
  en,
  valid,
}: {
  target: ContextTarget
  en: boolean
  valid: boolean
}) {
  const t = useTranslate()
  const id = useId()
  useWindowOverrides((s) => s.values)
  const { spec, manual, window, key, inheritedWindow } = resolveWindow(target)
  const [text, setText] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const value = text ?? String(manual ?? window)
  const parsed = parseWindow(value)
  const n = (x: number) => x.toLocaleString(en ? 'en-US' : 'zh-CN')
  const setWindow = async (next?: number) => {
    if (busy || !valid) {
      return
    }
    setBusy(true)
    try {
      if (target.profile) {
        await saveProfileWindow(target.profile.id, key, next)
      } else {
        saveBuiltinWindow(target, next)
      }
      setText(null)
      setStatus(
        next === undefined
          ? en
            ? 'Default restored.'
            : '已恢复默认值。'
          : en
            ? 'Saved.'
            : '已保存。'
      )
    } catch {
      setStatus(
        en
          ? 'Could not save. Check local storage and try again.'
          : '保存失败，请检查本机存储后重试。'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className={styles.field}>
        <label htmlFor={id}>{t('apiProfileContextWindow')}</label>
        <WindowTierChoices
          tiers={spec.tiers}
          en={en}
          selected={text === null ? window : parsed}
          disabled={!valid || busy}
          onSelect={(next) => void setWindow(next)}
        />
        <input
          id={id}
          data-context-window
          value={value}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={!parsed}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setText(e.target.value)
            setStatus('')
          }}
        />
      </div>
      <div id={`${id}-hint`} className={styles.details}>
        {!parsed && <p role="alert">{t('modelContextInvalid')}</p>}
        <p>
          {en ? 'Effective window' : '当前生效窗口'} <strong>{n(window)}</strong> tokens
          {manual != null
            ? en
              ? ' · Custom'
              : ' · 自定义'
            : inheritedWindow
              ? en
                ? ' · Provider preference'
                : ' · 服务方案设置'
              : ''}
        </p>
        <details className={styles.evidence}>
          <summary>{en ? 'Limits & sources' : '上限与来源'}</summary>
          <p>
            {spec.name && `${spec.name} · `}
            {basisText[spec.basis][en ? 1 : 0]} · {n(spec.window)} tokens
          </p>
          {spec.modelWindow && (
            <p>
              {en ? 'Model architecture limit' : '模型架构上限'} {n(spec.modelWindow)} tokens
            </p>
          )}
          {spec.input && (
            <p>
              {en ? 'Maximum input' : '最大输入'} {n(spec.input)} tokens
            </p>
          )}
          {spec.output && (
            <p>
              {en ? 'Maximum output' : '单次最大输出'} {n(spec.output)} tokens
            </p>
          )}
          {target.channel === 'workbuddy' && (
            <p>
              {en
                ? 'Android also limits the encoded request body to 5 MiB.'
                : 'Android 另有限制，编码后的请求体最多为 5 MiB。'}
            </p>
          )}
          {target.channel && !target.grant && (
            <p>
              {en
                ? 'Offline configuration. Each connected account has its own settings.'
                : '当前为离线配置，登录后可单独设置该账号。'}
            </p>
          )}
          {spec.urls.length > 0 && (
            <div className={styles.sources}>
              {spec.urls.map((url) => (
                <a
                  href={url}
                  key={url}
                  onClick={(e) => {
                    if (!e.defaultPrevented) {
                      e.preventDefault()
                      void openExternal(url)
                    }
                  }}
                >
                  {new URL(url).hostname}
                </a>
              ))}
            </div>
          )}
        </details>
      </div>
      <div className={styles.actions}>
        <Button
          size="m"
          data-context-save
          disabled={!valid || !parsed || busy}
          onClick={() => void setWindow(parsed)}
        >
          {en ? 'Save' : '保存'}
        </Button>
        <Button
          size="m"
          variant="outlined"
          data-context-reset
          disabled={!valid || busy}
          onClick={() => void setWindow()}
        >
          {en ? 'Restore default' : '恢复默认'}
        </Button>
      </div>
      <div role="status" className={styles.status}>
        {status}
      </div>
    </>
  )
}
