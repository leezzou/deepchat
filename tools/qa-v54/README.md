# DeepChat 1.0.54 回归

在仓库根目录执行命令。浏览器测试使用项目的生产 Rspack 构建或 APK 内的原始 WebView 资源，配合 Playwright、独立 Chromium 上下文、合成 WorkBuddy 账号及本地响应。每个用例都会重新创建浏览器存储。浏览器仅连接临时回环服务器。设置页的模型发现请求在浏览器内完成本地响应。

## 源码预检

```sh
ASSETS=$(node tools/qa-v54/build.mjs)
node tools/qa-v54/browser.mjs "$ASSETS" tmp/qa-v54-preflight-01
```

每次提供新的证据目录。报告包含 Chromium 版本、入口 JS SHA-256、页面版本、逐项断言和截图名。构建目录中的 `input.json` 记录源码快照摘要。默认运行手机 390×844 和桌面 1280×900、浅色和深色、标准动画和减少动态效果，共八种组合。API 配置表单的发现流程使用手机入口。`CHROME_EXECUTABLE_PATH` 可以指定 Chrome 程序。

```sh
QA_CASE=titles,thinking,search QA_VARIANT=phone-light-no-preference,desktop-dark-reduce \
  node tools/qa-v54/browser.mjs "$ASSETS" tmp/qa-v54-chat-01
QA_ANDROID_ACCOUNT_BRIDGE=1 QA_CASE=roster \
  node tools/qa-v54/browser.mjs "$ASSETS" tmp/qa-v54-dual-port-01
QA_ANDROID_ACCOUNT_BRIDGE=1 QA_VARIANT=phone-light-no-preference \
  QA_CASE=usage-claude,usage-gpt,usage-proxy,usage-silicon,usage-local \
  node tools/qa-v54/browser.mjs "$ASSETS" tmp/qa-v54-profile-ports-01
node --test chat-demo/src/services/workbuddy/provider.test.mjs chat-demo/src/services/api/accountRouting.test.mjs
```

| 用例 | 实测行为 |
| --- | --- |
| `titles` | 短中英文问题在回复前显示标题，历史改名、重载、修复旧标题。 |
| `thinking` | 等待、普通流式回答、带 v53 旧字段的历史记录和实际 reasoning 内容的展开状态。 |
| `stop` | 测量方块与圆的直径比、手机 48px 触控区域，点击停止并核对已接收正文。无正文停止后实际重新生成，长度截断后实际续写并核对持久化结果。 |
| `parity-workbuddy`、`parity-messages`、`parity-completions`、`parity-openrouter` | 固定 DeepSeek V4 Pro 和四组输入，测量每一路的请求参数和 SSE 事件、标题、展开思考、关闭思考、操作按钮与提前断流状态。 |
| `usage-claude`、`usage-gpt`、`usage-proxy`、`usage-silicon`、`usage-local` | 从设置打开空报告，使用手机配置页保存服务商、部署与合成 key（Ollama 免 key）。发送、截断后续写、手动停止，再打开手机设置或桌面数据管理报告，核对每笔请求和筛选汇总。兼容响应只有请求 `stream_options.include_usage` 才返回计数。 |
| `modePanel` | 在会话的模式面板选择具体型号并核对请求。 |
| `fileAttachments`、`files-official`、`files-router`、`files-custom` | 在聊天页选取和预览文件，核对 WorkBuddy 与三个 API 路由的附件发送。 |
| `search` | 搜索计划、重复来源去重、超过五篇实际页面正文、时间线和正文引用。 |
| `context`、`catalog` | 上下文按型号保存，数值恢复默认，键盘选型，供应商入口完整，数据来源可追溯。 |
| `discovery` | 填写密钥自动发现模型，更换供应商时清除旧密钥，迟到响应隔离，失败后手动输入部署名。 |
| `roster` | 选择账号提供的第四个型号，冷启动后发送并核对桥接请求中的 ID。 |
| `backup`、`backupEnglish` | 完成十轮时生成 ZIP，核对归档中的十组问答及 CRC。输入焦点、光标和草稿保留。关闭后再完成十轮并核对计数。删除时逐字节核对手动 ZIP，检查安全快照和会话记录。中英文提示及减少动态效果均使用实际 UI。 |

## 发布负责人发出公开链接并通知后

将 `PUBLISHED_APK` 和 `PREVIOUS_APK` 分别设为已下载的 v1.0.54 和 v1.0.53 签名包路径。先用发布清单核对公开下载件的摘要，再从同一文件提取 WebView 资源并运行原生升级。

```sh
shasum -a 256 "$PUBLISHED_APK" "$PREVIOUS_APK"
ASSETS=$(python3 tools/qa-v54/assets.py "$PUBLISHED_APK")
QA_STAGE=published-apk node tools/qa-v54/browser.mjs "$ASSETS" tmp/qa-v54-published-web-01
python3 tools/qa-v54/device.py "$PUBLISHED_APK" "$PREVIOUS_APK" tmp/qa-v54-published-android-01
```

Android 阶段使用 SDK 中的 API 34 Google APIs 镜像，在新的临时路径内创建 AVD。脚本先核对版本、签名与包名，确认设备身份、空白安装状态和离线网络，再安装 v1.0.53、输入未发送的草稿，并用 `adb install -r` 升级。验收记录保留已安装 APK 摘要、UID、首次安装时间、升级后恢复的草稿及原生 WebView 关键页面截图。
