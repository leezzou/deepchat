# 离线聊天模型目录

2026-11-20 快照覆盖项目的 34 个云端预设、Ollama、LM Studio 和自定义端点。按供应商分别计数，共有 1,517 个型号，其中 1,483 个有总上下文窗口，143 个有单列输入上限，1,285 个有单列输出上限。各预设的 ID、地址、数量、缺少总窗口的型号、已知需要其他协议的型号、来源与 SHA-256 均见[覆盖报告](coverage.json)。所有型号可在[供应商 JSON 分包](../../chat-demo/src/services/api/catalog-data/)逐项查询。

## 离线复现和增量更新

在仓库根目录运行，生成器使用 Python 3.9+ 标准库和 Node 22.18+。默认构建只读取随库保存的事实快照、人工核对数据与项目预设。现有锁定输入生成字节一致的分包及报告，只写入有变化的文件。

```sh
python3 tools/model-catalog/generate.py                      # 离线生成
python3 tools/model-catalog/generate.py --check              # 离线验证产物、来源和哈希
python3 tools/model-catalog/generate.py --refresh openrouter opencode-go   # 只刷新两个来源
python3 tools/model-catalog/generate.py --refresh            # 刷新全部网络来源
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/model-catalog -p 'test_*.py'
node --test chat-demo/src/services/api/modelCatalog.test.mjs  # Node 22.18+（含 registerHooks）
```

`--refresh` 访问公开元数据，无需密钥。一次刷新从指定来源重新读取完整列表，然后按供应商和大小写敏感的型号 ID 去重、筛选、排序及合并。发生网络、格式或端点身份错误时，应保留当前快照。新增或迁移预设时，先复核供应商身份，再同步[预设地址清单](origins.json)与[上游映射和采集器](sources.py)。

## 读取

读取接口按需引入当前供应商的 JSON。所有供应商的分包共 112,276 字节。调用方可共享同一加载 Promise，加载完成后同步精确查找。供应商名、模型名、字符串前缀和自定义网关中相同的型号 ID 均不能单独证明两个部署具有相同窗口。[读取 API](../../chat-demo/src/services/api/modelCatalog.ts)

```ts
const rows = await loadCatalogModels('opencode')
const model = resolveCatalogModel('opencode', 'big-pickle')
// model.contextWindow === 200000, model.inputLimit === 160000, model.outputLimit === 32000
```

分包内每行是 `[id, name|null, contextWindow|null, inputLimit|null, outputLimit|null, sourceIndex, supportsChatCompletions?]`。空名称表示显示 ID。`sourceIndex` 对应本包的 `[名称, HTTPS URL]`。整数单位均为 tokens。窗口、输入和输出分别取证，缺哪一项就保留空值。显式 `supportsChatCompletions: false` 的条目仍是聊天型号，供应商将其部署在其他协议上。未提供此字段代表来源未声明协议支持。

## 覆盖及来源

- [models.dev 的官方 API](https://models.dev/api.json)提供显式映射的 31 个预设的补充事实。固定的模型库快照保留 provider key、大小写精确的型号 ID 和原始响应 SHA-256。GitHub `dev` 分支的同期 HEAD 为 [`9a9ecdd605f101d74fdc8159c69a542e23e97658`](https://github.com/anomalyco/models.dev/commit/9a9ecdd605f101d74fdc8159c69a542e23e97658)，提交时间 2026-11-20 06:37:01 UTC。API 自身没有声明对应提交，复现以快照和内容哈希为准。归一化记录见[锁定输入](snapshots/)。
- 同一供应商的官方模型列表优先，包括 [OpenRouter](https://openrouter.ai/api/v1/models)、[OpenCode Zen](https://opencode.ai/inference/openai/v1/models)、[OpenCode Go](https://opencode.ai/inference/go/openai/v1/models)、[DeepInfra](https://api.deepinfra.com/v1/openai/models)、[Novita](https://api.novita.ai/v3/openai/models)、[SambaNova](https://api.sambanova.ai/v1/models)、[Cerebras](https://api.cerebras.ai/public/v1/models) 和[硅基流动](https://siliconflow.cn/models)。对列出接口类型或模态的来源，使用相应字段筛选聊天型号。OpenRouter 的输出上限来自其首选路由 `top_provider.max_completion_tokens`，实际路由可能不同。
- 官方文档覆盖 [OpenAI 的全量型号卡及默认快照](https://developers.openai.com/api/docs/models/all.md)、[Anthropic 型号卡](https://platform.claude.com/docs/en/models/overview)、[Together 服务端文本和视觉模型](https://docs.together.ai/docs/serverless-models.md)、[Groq](https://console.groq.com/docs/models.md) 和 [Cohere](https://docs.cohere.com/docs/models)。若一个列名来源未给出任何可用整数规格，可保留该供应商相同型号的另一来源的完整数值组和来源。各文档中只明确给出的全窗口或精确默认快照可共享该项事实，历史版本保留自己的记录。
- 百度千帆、腾讯 TokenHub、讯飞星火、商汤与百川使用[逐项核查的官方资料](overrides/)。例如，Spark HTTP 文档分别给出了输入和输出限制，六个 Spark 型号的总窗口均保留空值。新增人工资料沿用 `sources` 和 `rows` 格式，并注明可复核的官方 HTTPS 文档。
- 静态目录覆盖快照内可核实的候选型号，包括历史别名、有准入限制的型号和公开目录列出的补充型号。账户权限、地区、下线时间、协议和路由会改变实际可用列表。Ollama 和 LM Studio 的四条记录标为 `local-reference`，可配置的本机上下文由实际实例返回。自定义端点只靠现场发现或用户配置补充。

## 许可

models.dev 的 MIT 许可和版权声明已随应用打包进[许可证](../../chat-demo/LICENSE)。其他公开来源仅摘录型号、显示名称、数值及接口事实，附原始 URL。各模型的使用和服务条款由相应供应商规定。
