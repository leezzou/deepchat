# 深度思考与展示思考

**深度思考**会为当前模型发送服务商公开支持的开启或关闭参数。**展示思考**只控制是否显示服务商实际返回的公开思考文本或摘要。固定推理模型在关闭展示后仍可能产生推理费用。未知兼容端点可选择展示其真实输出。普通答复、加密数据、签名和用量计数均不会转换成思考文本。

本地发现以配置的完整端点、协议和精确模型 ID 为范围。模型列表中的名称只表明可选择该模型。识别到固定推理或无推理的发现结果时，客户端尊重这个限制。自定义网关需要与自身契约相符的参数，官方同名模型的能力不能跨端点继承。地区、账户和部署权限仍由服务商决定。

| 预设 | 精确模型的请求行为及依据 |
| --- | --- |
| DeepSeek 官方 | Flash、Pro 等已核对型号使用 `thinking.type`。[官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) |
| 阿里百炼（中国、国际） | 已列明的 Qwen 4、3.8、3.7、3.6、3.5、Plus、Flash，以及部分托管 GLM、Kimi、DeepSeek 使用 `enable_thinking`。`qwen3.7-max-preview`、`glm-5.3`、`kimi-k2.7-code` 等保持固定计算。两地实际可用型号以各账户模型列表为准。[型号表](https://www.alibabacloud.com/help/en/model-studio/deep-thinking) · [兼容接口](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) |
| 智谱 GLM、Z.ai 国际 | GLM 4.6、4.7、5、5.1、5.2 使用 `thinking.type`。5.3 和 5.3 Flash 固定推理。[智谱](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode) · [Z.ai](https://docs.z.ai/guides/capabilities/thinking-mode) |
| 月之暗面 Kimi（中国、国际） | K2.6 使用 `thinking.type`。K2.7 Code、K3、K3.1 Pro 固定推理。K3 的努力等级低档仍会计算。[模型参数参考](https://platform.kimi.com/docs/api/models-overview) |
| SiliconFlow | 确认的 Qwen3、GLM 视觉、Hunyuan、DeepSeek 型号使用 `enable_thinking`。[Chat Completions](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions) |
| 火山方舟、百度千帆 | 方舟已列明的 Seed 快照使用 `thinking.type`。千帆 `ernie-light-dt-1.0` 使用 `thinking.type`，已列明的 Qwen3、ERNIE 快照使用 `enable_thinking`，`ernie-5.5-flash-preview` 固定思考。[方舟](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh) · [千帆](https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv) |
| MiniMax（中国、国际）、阶跃星辰 | MiniMax M3 使用 `thinking.type=adaptive/disabled` 并分离输出。M3.1 Flash 固定推理。Step 3.7 Flash 提供强度档，界面只控制展示。[MiniMax](https://platform.minimax.io/docs/api-reference/text-openai-api) · [StepFun](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash) |
| OpenAI、Anthropic | 官方端点交由专用适配器处理。支持的 GPT Chat 型号使用 `reasoning_effort`。支持摘要的 Responses 或 Claude 型号仅呈现实际摘要。Claude 可切换机型依其原生 Messages 契约。[OpenAI](https://developers.openai.com/api/docs/guides/reasoning) · [Claude](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) |
| Gemini | 2.5 Flash 与 Flash-Lite 支持 `thinking_budget` 的动态值和零预算。2.5 Pro 及列明的 3、4 系列使用 `extra_body.google.thinking_config.include_thoughts` 请求公开摘要，保留模型计算策略。[OpenAI 兼容层](https://ai.google.dev/gemini-api/docs/openai) |
| Groq、xAI | Groq `qwen/qwen3.8-27b` 使用 `reasoning_effort=medium/none` 和 `reasoning_format`。GPT-OSS 和 Muse 固定推理。xAI 列明的 Grok 4.5–4.7 保留服务商的计算策略。[Groq](https://console.groq.com/docs/reasoning) · [xAI](https://docs.x.ai/developers/model-capabilities/text/reasoning) |
| Together、Fireworks、DeepInfra | Together 已列明的混合模型使用 `reasoning.enabled`。Fireworks 和 DeepInfra 已核对的混合型号使用 `reasoning_effort=high/none`。独立部署或私有别名的设置由该部署决定。[Together](https://docs.together.ai/docs/inference/chat/reasoning) · [Fireworks](https://docs.fireworks.ai/api-reference/post-chatcompletions) · [DeepInfra](https://docs.deepinfra.com/chat/reasoning) |
| Cohere | 已确认的 Command A reasoning/plus 在兼容端点使用 `reasoning_effort=high/none`。[兼容 API](https://docs.cohere.com/v2/docs/compatibility-api) |
| OpenRouter、Ollama | 使用原有的精确端点和模型绑定。OpenRouter 可依据账户模型发现确认 `reasoning.enabled`。Ollama 可依 `/api/show` 能力选择已知的 `reasoning_effort` 映射。[OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) · [Ollama](https://docs.ollama.com/capabilities/thinking) |
| OpenCode Zen、OpenCode Go | Zen 的已核对 DeepSeek 型号使用 `thinking.type`。独立 Go 接入保持其自身契约。[OpenCode 模型](https://opencode.ai/docs/zen/) |
| 腾讯混元、星火、商汤、百川、Mistral、Cerebras、SambaNova、Novita、Perplexity、LM Studio、自定义 | 预设中的端点、模型、地区或协议存在差异。未录入精确计算开关的组合保留可选的公开输出展示。服务商可通过模型发现明确声明无推理。 |

验证使用本地 HTTP 测试夹具覆盖应用的正常发送入口、开启与关闭两种请求、固定和未知模型、同名跨网关模型、真实文本的显示与隐藏。夹具验证的是序列化与界面事件，与付费账户的实时模型可用性分别核实。
