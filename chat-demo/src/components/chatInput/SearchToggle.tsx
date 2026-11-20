import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setSearch } from '../../services/settings.js'
import { searchCapability } from '../../services/api/searchCapabilities.js'
import {
  allowSearch,
  retrievalSources,
  revokeSearchGrant,
  routeSearchEnabled,
  useSearchConsent,
  type SearchRoute,
} from '../../services/api/searchConsent.js'
import { Button } from '../base/Button.js'
import { ConfirmationModal, ModalPresence } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Tooltip } from '../base/Tooltip.js'
import { IconGlobeLanguageOutline14 } from '../base/icons.js'
import styles from './ChatInput.module.css'

export function SearchToggle({
  route,
  sessionId,
  search,
  en,
}: {
  route: SearchRoute & {
    search: boolean
    workbuddy?: boolean
    missing: boolean
    needsApproval: boolean
  }
  sessionId: string | null
  search: boolean
  en: boolean
}) {
  const t = useTranslate()
  useSearchConsent((s) => s.revision)
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState('')
  const [terms, setTerms] = useState('')
  const cap = searchCapability(route.origin, route.protocol, route.model)
  const builtin = route.workbuddy || cap === 'deepseek'
  const portable = !builtin && cap === 'none'
  const enabled = builtin ? route.search : routeSearchEnabled(route, sessionId)
  const pressed = enabled && search
  const sources = portable ? retrievalSources() : []
  const available =
    !route.missing && !route.needsApproval && (builtin || !portable || !!sources.length)
  const tooltip = !available
    ? en
      ? 'Search unavailable for this model and connection'
      : '当前模型和渠道暂无可用搜索服务'
    : portable
      ? en
        ? 'Choose a service and enter search terms for this reply'
        : '选择搜索服务并输入本次检索词'
      : route.workbuddy
        ? en
          ? 'Search with your WorkBuddy account'
          : '使用 WorkBuddy 账号搜索'
        : t('deactivatedSearchTooltip')
  const selected = sources.find((s) => s.id === source)
  return (
    <>
      <Tooltip content={tooltip}>
        <button
          type="button"
          className={clsx(styles.toggle, pressed && styles.selected)}
          aria-label={t('search')}
          aria-pressed={pressed}
          disabled={!available}
          onClick={() => {
            if (builtin) {
              setSearch(!search)
              return
            }
            if (enabled) {
              revokeSearchGrant(route, sessionId)
              return
            }
            setTerms('')
            setSource(sources[0]?.id || '')
            setOpen(true)
          }}
        >
          <IconGlobeLanguageOutline14 />
          <span className={styles.toggleLabel}>{t('search')}</span>
        </button>
      </Tooltip>
      <ModalPresence>
        {open && (
          <ConfirmationModal
            title={
              portable
                ? en
                  ? 'Search for this reply'
                  : '为本次回答搜索'
                : en
                  ? 'Enable provider search?'
                  : '开启服务商搜索？'
            }
            onClose={() => setOpen(false)}
            footer={
              <>
                <Button variant="outlined" size="m" onClick={() => setOpen(false)}>
                  {t('cancel')}
                </Button>
                <Button
                  size="m"
                  disabled={
                    portable &&
                    (!selected || !terms.trim() || Array.from(terms.trim()).length > 128)
                  }
                  onClick={() => {
                    if (
                      allowSearch(
                        route,
                        sessionId,
                        portable ? source : undefined,
                        portable ? terms : undefined
                      )
                    ) {
                      setSearch(true)
                      setOpen(false)
                    }
                  }}
                >
                  {en ? 'Enable search' : '开启搜索'}
                </Button>
              </>
            }
          >
            {portable ? (
              <div className="conversation-mode-form">
                <p>
                  {en
                    ? `Only the terms below go to the selected search service once. ${route.model} receives the results and answers your question. Search charges may apply.`
                    : `仅将下方检索词发给所选服务一次，结果交给 ${route.model} 回答。搜索可能产生费用。`}
                </p>
                <label>
                  {en ? 'Search service' : '搜索服务'}
                  <Select
                    ariaLabel={en ? 'Search service' : '搜索服务'}
                    value={source}
                    options={sources.map((s) => ({ value: s.id, label: s.label }))}
                    onChange={setSource}
                  />
                </label>
                <label>
                  {en ? 'Public search terms' : '公开检索词'}
                  <input maxLength={128} value={terms} onChange={(e) => setTerms(e.target.value)} />
                </label>
              </div>
            ) : (
              <p>
                {cap === 'openrouter'
                  ? en
                    ? 'OpenRouter may share search queries with its search engine, such as Exa. Search may cost extra. Enable it for this model until you turn it off or close the app?'
                    : 'OpenRouter 可能将检索请求交给 Exa 等搜索引擎，并额外收费。为此模型启用至手动关闭或退出应用？'
                  : cap === 'openai'
                    ? en
                      ? 'OpenAI can search the web and return sources for this model. Search may cost extra. Enable it until you turn it off or close the app?'
                      : 'OpenAI 可为此模型联网搜索并返回来源，搜索可能额外收费。启用至手动关闭或退出应用？'
                  : cap === 'anthropic'
                    ? en
                      ? 'Claude can send search terms to Anthropic’s search service. Fees may apply. Enable search for this model until you turn it off or close the app?'
                      : 'Claude 可将检索词发送给 Anthropic 的搜索服务，可能额外收费。为此模型启用至手动关闭或退出应用？'
                    : en
                      ? 'Alibaba Cloud can search the web for this model. This API does not return a source list. Fees may apply. Enable search until you turn it off or close the app?'
                      : '阿里云可为此模型联网搜索；此接口不返回来源清单。搜索可能额外收费。启用至手动关闭或退出应用？'}
              </p>
            )}
          </ConfirmationModal>
        )}
      </ModalPresence>
    </>
  )
}
