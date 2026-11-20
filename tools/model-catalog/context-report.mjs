// Run with Node 24+ from any directory. Writes the current defaults table to stdout.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
registerHooks({ resolve(id, ctx, next) {
  if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL) {
    const ts = new URL(id.replace(/\.js$/, '.ts'), ctx.parentURL)
    if (existsSync(ts)) return next(ts.href, ctx)
  }
  return next(id, ctx)
} })
const { providerPresets } = await import('../../chat-demo/src/services/api/providerPresets.ts')
const { getModelWindow, nativeModels } = await import('../../chat-demo/src/services/api/modelWindows.ts')
const { loadCatalogModels } = await import('../../chat-demo/src/services/api/modelCatalog.ts')
const { WORKBUDDY_MODELS } = await import('../../chat-demo/src/services/workbuddy/models.ts')
const { default: coverage } = await import('./coverage.json', { with: { type: 'json' } })
const basis = { provider: '官方规格', model: '上游模型参考', variable: '取决于部署', historical: '历史型号', input: '输入上限', discovered: '账号返回', bundled: '客户端内置输入预算', catalog: '供应商型号目录', fallback: '应用临时预算' }
const format = value => value ? value.toLocaleString('en-US') : '—'
const rows = []
function add(label, provider, model) {
  const spec = getModelWindow(provider, model)
  const sources = [...new Set(spec.urls)].map(url => `[${new URL(url).hostname}](${url})`).join('、') || '待实例查询'
  rows.push(`| ${label} | ${model ? `\`${model}\`` : '由用户填写'} | ${format(spec.window)} | ${format(spec.input)} | ${format(spec.output)} | ${basis[spec.basis]} | ${sources} |`)
}
for (const model of nativeModels) add('DeepSeek 登录账号', 'deepseek', model)
for (const model of WORKBUDDY_MODELS) add('WorkBuddy 离线', 'workbuddy', model)
for (const preset of providerPresets) {
  const list = await loadCatalogModels(preset.value)
  const label = `[${preset.label}（${list.length}）](../chat-demo/src/services/api/catalog-data/${preset.value}.json)`
  for (const model of preset.value === 'deepseek' ? nativeModels : [preset.model]) add(label, preset.value, model)
}
process.stdout.write(`# 模型上下文窗口 · v1.0.54

2026-11-20 的离线目录覆盖 ${providerPresets.length} 项服务方案，包含 ${format(coverage.totalModels)} 个服务方案与模型 ID 组合，${format(coverage.knownContext)} 条有总窗口字段。表中给出各方案的初始模型及其预算。点击服务方案名称可查看对应方案收录的全部 ID。目录、账号权限和本地部署可分别更新。[目录来源与采集方法](../tools/model-catalog/README.md) · [逐方案覆盖数据](../tools/model-catalog/coverage.json)

数值单位为 tokens。横线表示该项缺少单列限制。已发布输入上限的服务会按该上限检查发送内容。应用为未知部署暂用 128,000 tokens，可在「设置 → 模型上下文」中调整。原来仅公布 K 单位的历史值或上游参考值，用于设置初始预算。实际请求还受账号档位、实例配置及网关限制。

| 服务方案（目录条目） | 初始模型 ID | 默认预算 | 独立输入上限 | 最大输出 | 预算依据 | 来源 |
| --- | --- | ---: | ---: | ---: | --- | --- |
${rows.join('\n')}

## 渠道和模型的差异

- DeepSeek 登录账号与官方 API 的 Flash 和 Pro 均有 1,048,576 总窗口及 393,216 最大输出。Flash 的官方调用 ID 为 \`deepseek-flash\`，其当前后端为 DeepSeek-V4.1-Flash-1017。[官方模型接口](https://api-docs.deepseek.com/zh-cn/api/list-models/) · [定价及别名](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- WorkBuddy 离线配置为三个兼容 ID 各提供 1,000,000 的输入预算。登录后使用该账号获得的型号、档位和默认预算。Android 还检查编码后的请求体，限制为 5 MiB。公开说明介绍账号、模型及档位，离线数值来自客户端发行配置。[WorkBuddy 模型说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)
- OpenCode Zen 的 \`big-pickle\` 具有 200,000 总窗口、160,000 输入和 32,000 输出。\`deepseek-v4.1-flash-free\` 为 200,000 总窗口和 32,000 输出。付费的 \`deepseek-v4.1-flash\` 与 Go 同名型号均公布 1,000,000 总窗口和 384,000 输出。[Zen 模型接口](https://opencode.ai/inference/openai/v1/models) · [Go 模型接口](https://opencode.ai/inference/go/openai/v1/models)
- OpenRouter 的 \`z-ai/glm-4.6\` 公共目录给出 204,800，上游路由公布的窗口包含 198,000 到 204,800。初始预算取 198,000。不同路由的输出上限也有差异。[当前各条路由](https://openrouter.ai/api/v1/models/z-ai/glm-4.6/endpoints)
- Ollama 和 LM Studio 的运行配置可小于模型架构上限。选择已有实例后，可使用实例返回的已加载窗口。Ollama 的自动上下文随可用显存变化，离线时取 4,096 规划初始预算。[Ollama 上下文](https://docs.ollama.com/context-length) · [LM Studio 实例](https://lmstudio.ai/docs/developer/rest/list)

## 编辑和生效范围

在「设置 → 模型上下文」选择服务方案，下一个控件可选择或输入精确模型 ID。保存后，同一会话的窗口显示、发送保护和摘要预算都会更新。「恢复默认」只重置当前方案和型号。

账号配置随本机登录授权区分。API 配置按配置 ID、接口、协议和大小写敏感的模型 ID 保存。每个配置的手动值优先于服务方案的手动值，接下来依次使用部署数据、对应目录和初始预算。旧版本手动填写的窗口继续适用，单独重置某个型号后，其他型号仍保留旧值。新建腾讯 TokenHub 或商汤兼容配置使用新的接口地址。已保存配置沿用原地址和原凭据。

发送前估算消息、附件、系统指令和工具内容，并为输出及分词误差预留余量。如果已开启自动摘要，会在达到模型窗口的 80% 时尝试压缩已选历史。超过可用预算时保留原文，并提示用户减少附件、调整轮次或更换模型。
`)
