# 模型上下文窗口 · v1.0.55

2026-11-20 的离线目录覆盖 37 项服务方案，包含 1,517 个服务方案与模型 ID 组合，1,483 条有总窗口字段。表中给出各方案的初始模型及其预算。点击服务方案名称可查看对应方案收录的全部 ID。目录、账号权限和本地部署可分别更新。[目录来源与采集方法](../tools/model-catalog/README.md) · [逐方案覆盖数据](../tools/model-catalog/coverage.json)

数值单位为 tokens。横线表示该项缺少单列限制。已发布输入上限的服务会按该上限检查发送内容。应用为未知部署暂用 128,000 tokens，可在「设置 → 模型上下文」中调整。原来仅公布 K 单位的历史值或上游参考值，用于设置初始预算。实际请求还受账号档位、实例配置及网关限制。

| 服务方案（目录条目） | 初始模型 ID | 默认预算 | 独立输入上限 | 最大输出 | 预算依据 | 来源 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| DeepSeek 登录账号 | `deepseek-flash` | 1,048,576 | — | 393,216 | 官方规格 | [api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/api/list-models/)、[api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| DeepSeek 登录账号 | `deepseek-v4-pro` | 1,048,576 | — | 393,216 | 官方规格 | [api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/api/list-models/)、[api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| WorkBuddy 离线 | `deepseek-v4.1-flash` | 1,000,000 | — | — | 客户端内置输入预算 | [www.codebuddy.cn](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) |
| WorkBuddy 离线 | `deepseek-v4-pro` | 1,000,000 | — | — | 客户端内置输入预算 | [www.codebuddy.cn](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) |
| WorkBuddy 离线 | `deepseek-v4-flash` | 1,000,000 | — | — | 客户端内置输入预算 | [www.codebuddy.cn](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) |
| [DeepSeek 官方（4）](../chat-demo/src/services/api/catalog-data/deepseek.json) | `deepseek-flash` | 1,048,576 | — | 393,216 | 官方规格 | [api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/api/list-models/)、[api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| [DeepSeek 官方（4）](../chat-demo/src/services/api/catalog-data/deepseek.json) | `deepseek-v4-pro` | 1,048,576 | — | 393,216 | 官方规格 | [api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/api/list-models/)、[api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| [智谱 GLM（17）](../chat-demo/src/services/api/catalog-data/glm.json) | `glm-4.6` | 204,800 | — | 131,072 | 供应商型号目录 | [models.dev](https://models.dev/#zhipuai) |
| [智谱 GLM（国际）（18）](../chat-demo/src/services/api/catalog-data/zai.json) | `glm-4.6` | 204,800 | — | 131,072 | 供应商型号目录 | [models.dev](https://models.dev/#zai) |
| [阿里云百炼（通义千问）（77）](../chat-demo/src/services/api/catalog-data/qwen.json) | `qwen3-max` | 262,144 | — | 65,536 | 供应商型号目录 | [models.dev](https://models.dev/#alibaba-cn) |
| [阿里云百炼（国际）（49）](../chat-demo/src/services/api/catalog-data/qwen-intl.json) | `qwen3-max` | 262,144 | — | 65,536 | 供应商型号目录 | [models.dev](https://models.dev/#alibaba) |
| [月之暗面 Kimi（7）](../chat-demo/src/services/api/catalog-data/kimi.json) | `kimi-k2-0905-preview` | 262,144 | — | — | 历史型号 | [platform.kimi.com](https://platform.kimi.com/docs/pricing/chat)、[platform.kimi.com](https://platform.kimi.com/docs/models) |
| [月之暗面 Kimi（国际）（7）](../chat-demo/src/services/api/catalog-data/kimi-intl.json) | `kimi-k2-0905-preview` | 262,144 | — | — | 历史型号 | [platform.kimi.com](https://platform.kimi.com/docs/pricing/chat)、[platform.kimi.com](https://platform.kimi.com/docs/models) |
| [硅基流动 SiliconFlow（63）](../chat-demo/src/services/api/catalog-data/siliconflow.json) | `deepseek-ai/DeepSeek-V3` | 163,840 | — | — | 供应商型号目录 | [siliconflow.cn](https://siliconflow.cn/models) |
| [火山方舟（豆包）（17）](../chat-demo/src/services/api/catalog-data/volcengine.json) | `doubao-seed-1-6` | 256,000 | — | — | 上游模型参考 | [console.volcengine.com](https://console.volcengine.com/ark/region:cn-beijing/model/detail?Id=doubao-seed-1-6) |
| [百度千帆（文心）（49）](../chat-demo/src/services/api/catalog-data/qianfan.json) | `ernie-5.1` | 131,072 | 121,856 | 65,536 | 供应商型号目录 | [cloud.baidu.com](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j) |
| [腾讯混元（41）](../chat-demo/src/services/api/catalog-data/hunyuan.json) | `hy4-flash` | 1,048,576 | 983,040 | 65,536 | 供应商型号目录 | [cloud.tencent.com](https://cloud.tencent.com/document/product/1823/130051) |
| [MiniMax（8）](../chat-demo/src/services/api/catalog-data/minimax.json) | `MiniMax-M2` | 204,800 | — | 131,072 | 供应商型号目录 | [models.dev](https://models.dev/#minimax-cn) |
| [MiniMax（国际）（8）](../chat-demo/src/services/api/catalog-data/minimax-intl.json) | `MiniMax-M2` | 204,800 | — | 131,072 | 供应商型号目录 | [models.dev](https://models.dev/#minimax) |
| [阶跃星辰 StepFun（5）](../chat-demo/src/services/api/catalog-data/stepfun.json) | `step-2-16k` | 16,000 | — | — | 历史型号 | [platform.stepfun.com](https://platform.stepfun.com/docs/zh/guides/model-migration) |
| [讯飞星火（6）](../chat-demo/src/services/api/catalog-data/spark.json) | `4.0Ultra` | 32,768 | 32,768 | 32,768 | 输入上限 | [www.xfyun.cn](https://www.xfyun.cn/doc/spark/HTTP调用文档.html) |
| [商汤日日新（12）](../chat-demo/src/services/api/catalog-data/sensenova.json) | `SenseChat-5` | 131,072 | — | — | 供应商型号目录 | [www.sensecore.cn](https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode) |
| [百川智能（12）](../chat-demo/src/services/api/catalog-data/baichuan.json) | `Baichuan4` | 32,000 | — | — | 供应商型号目录 | [platform.baichuan-ai.com](https://platform.baichuan-ai.com/prices) |
| [OpenAI（121）](../chat-demo/src/services/api/catalog-data/openai.json) | `gpt-4.1` | 1,047,576 | — | 32,768 | 供应商型号目录 | [developers.openai.com](https://developers.openai.com/api/docs/models/gpt-4.1.md) |
| [Anthropic Claude（21）](../chat-demo/src/services/api/catalog-data/anthropic.json) | `claude-sonnet-5-5` | 1,000,000 | — | 128,000 | 供应商型号目录 | [platform.claude.com](https://platform.claude.com/docs/en/models/sonnet-5-5/overview.md) |
| [Google Gemini（27）](../chat-demo/src/services/api/catalog-data/gemini.json) | `gemini-2.5-pro` | 1,048,576 | 1,048,576 | 65,536 | 输入上限 | [ai.google.dev](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)、[models.dev](https://models.dev/#google) |
| [xAI Grok（8）](../chat-demo/src/services/api/catalog-data/xai.json) | `grok-4` | 128,000 | — | — | 应用临时预算 | [docs.x.ai](https://docs.x.ai/developers/migration/may-15-retirement) |
| [Mistral（33）](../chat-demo/src/services/api/catalog-data/mistral.json) | `mistral-large-latest` | 1,048,576 | — | 262,144 | 供应商型号目录 | [models.dev](https://models.dev/#mistral) |
| [Groq（9）](../chat-demo/src/services/api/catalog-data/groq.json) | `llama-3.3-70b-versatile` | 131,072 | — | 32,768 | 供应商型号目录 | [console.groq.com](https://console.groq.com/docs/models.md) |
| [Together AI（45）](../chat-demo/src/services/api/catalog-data/together.json) | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | 131,072 | — | 131,072 | 供应商型号目录 | [models.dev](https://models.dev/#togetherai) |
| [Fireworks AI（28）](../chat-demo/src/services/api/catalog-data/fireworks.json) | `accounts/fireworks/models/llama-v3p3-70b-instruct` | 131,000 | — | — | 取决于部署 | [fireworks.ai](https://fireworks.ai/models/fireworks/llama-v3p3-70b-instruct) |
| [DeepInfra（115）](../chat-demo/src/services/api/catalog-data/deepinfra.json) | `deepseek-ai/DeepSeek-V3` | 163,840 | — | — | 供应商型号目录 | [api.deepinfra.com](https://api.deepinfra.com/v1/openai/models) |
| [Cerebras（3）](../chat-demo/src/services/api/catalog-data/cerebras.json) | `llama-3.3-70b` | 128,000 | — | — | 应用临时预算 | [inference-docs.cerebras.ai](https://inference-docs.cerebras.ai/models/overview) |
| [SambaNova（5）](../chat-demo/src/services/api/catalog-data/sambanova.json) | `Meta-Llama-3.3-70B-Instruct` | 128,000 | — | — | 官方规格 | [docs.sambanova.ai](https://docs.sambanova.ai/docs/en/models/sambacloud-models) |
| [Novita AI（96）](../chat-demo/src/services/api/catalog-data/novita.json) | `deepseek/deepseek-v3` | 128,000 | — | — | 上游模型参考 | [huggingface.co](https://huggingface.co/deepseek-ai/DeepSeek-V3) |
| [OpenRouter（385）](../chat-demo/src/services/api/catalog-data/openrouter.json) | `z-ai/glm-4.6` | 198,000 | — | 131,072 | 取决于部署 | [openrouter.ai](https://openrouter.ai/api/v1/models/z-ai/glm-4.6/endpoints)、[openrouter.ai](https://openrouter.ai/api/v1/models) |
| [Perplexity（4）](../chat-demo/src/services/api/catalog-data/perplexity.json) | `sonar` | 128,000 | — | 4,096 | 供应商型号目录 | [models.dev](https://models.dev/#perplexity) |
| [Cohere（27）](../chat-demo/src/services/api/catalog-data/cohere.json) | `command-r-plus` | 128,000 | — | 4,096 | 历史型号 | [docs.cohere.com](https://docs.cohere.com/docs/command-r-plus) |
| [OpenCode Zen（按量）（144）](../chat-demo/src/services/api/catalog-data/opencode.json) | `deepseek-v4.1-flash` | 1,000,000 | — | 384,000 | 供应商型号目录 | [opencode.ai](https://opencode.ai/inference/openai/v1/models) |
| [OpenCode Go（订阅）（42）](../chat-demo/src/services/api/catalog-data/opencode-go.json) | `deepseek-v4.1-flash` | 1,000,000 | — | 384,000 | 供应商型号目录 | [opencode.ai](https://opencode.ai/inference/go/openai/v1/models) |
| [Ollama（本机）（1）](../chat-demo/src/services/api/catalog-data/ollama.json) | `llama3.2` | 4,096 | — | — | 取决于部署 | [docs.ollama.com](https://docs.ollama.com/context-length) |
| [LM Studio（本机）（3）](../chat-demo/src/services/api/catalog-data/lmstudio.json) | `local-model` | 128,000 | — | — | 应用临时预算 | [lmstudio.ai](https://lmstudio.ai/docs/developer/rest/list) |
| [自定义（OpenAI 兼容）（0）](../chat-demo/src/services/api/catalog-data/custom.json) | 由用户填写 | 128,000 | — | — | 应用临时预算 | 待实例查询 |

## 渠道和模型的差异

- DeepSeek 登录账号与官方 API 的 Flash 和 Pro 均有 1,048,576 总窗口及 393,216 最大输出。Flash 的官方调用 ID 为 `deepseek-flash`，其当前后端为 DeepSeek-V4.1-Flash-1017。[官方模型接口](https://api-docs.deepseek.com/zh-cn/api/list-models/) · [定价及别名](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- WorkBuddy 离线配置为三个兼容 ID 各提供 1,000,000 的输入预算。登录后按该账号和型号的最高有效档位规划预算。用户可选较低档位或填写精确值。官方客户端用会话窗口预算准备聊天历史和摘要。Android 还检查编码后的请求体，限制为 5 MiB。公开说明介绍账号、模型及档位，离线数值来自客户端发行配置。[WorkBuddy 模型说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)
- OpenCode Zen 的 `big-pickle` 具有 200,000 总窗口、160,000 输入和 32,000 输出。`deepseek-v4.1-flash-free` 为 200,000 总窗口和 32,000 输出。付费的 `deepseek-v4.1-flash` 与 Go 同名型号均公布 1,000,000 总窗口和 384,000 输出。[Zen 模型接口](https://opencode.ai/inference/openai/v1/models) · [Go 模型接口](https://opencode.ai/inference/go/openai/v1/models)
- OpenRouter 的 `z-ai/glm-4.6` 公共目录给出 204,800，上游路由公布的窗口包含 198,000 到 204,800。初始预算取 198,000。不同路由的输出上限也有差异。[当前各条路由](https://openrouter.ai/api/v1/models/z-ai/glm-4.6/endpoints)
- Ollama 和 LM Studio 的运行配置可小于模型架构上限。选择已有实例后，可使用实例返回的已加载窗口。Ollama 的自动上下文随可用显存变化，离线时取 4,096 规划初始预算。[Ollama 上下文](https://docs.ollama.com/context-length) · [LM Studio 实例](https://lmstudio.ai/docs/developer/rest/list)

## 编辑和生效范围

在「设置 → 模型上下文」选择服务方案，下一个控件可选择或输入精确模型 ID。保存后，同一会话的窗口显示、发送保护和摘要预算都会更新。「恢复默认」只重置当前方案和型号。模型接口明确提供多档窗口时，默认选当前部署支持的最高有效档位。点击数字即可选档，已保存的手动值随配置保留，发送时受实际部署上限约束。

账号配置随本机登录授权区分。API 配置按配置 ID、接口、协议和大小写敏感的模型 ID 保存。每个配置的手动值优先于服务方案的手动值，接下来依次使用部署数据、对应目录和初始预算。旧版本手动填写的窗口继续适用，单独重置某个型号后，其他型号仍保留旧值。新建腾讯 TokenHub 或商汤兼容配置使用新的接口地址。已保存配置沿用原地址和原凭据。

发送前估算消息、附件、系统指令和工具内容，并为输出及分词误差预留余量。如果已开启自动摘要，会在达到模型窗口的 80% 时尝试压缩已选历史。超过可用预算时保留原文，并提示用户减少附件、调整轮次或更换模型。
