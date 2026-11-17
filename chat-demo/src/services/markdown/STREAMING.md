# Markdown 流式渲染

`Markdown` 对外仍使用 `content`、`loading`、`cacheKey`、`disableLink`、`sources`，无需改调用方。

- 展示层把上游合并的文本分成小段。通常最短间隔为 24ms，根据积压量加速追赶；尾部超过 12k/48k 字符时，最短间隔增至 80/160ms。实际 React 提交耗时还能把间隔提高到最多 240ms。
- `loading=false`、非追加替换和 `cacheKey` 切换在当次渲染直接返回全部正文。展示计时器不会推迟完成、停止或错误状态的最终文本。
- 支持 `prefers-reduced-motion`；隐藏页面和减少动态效果模式跳过小段显示。计时器读取最新输入，高频输入不会不断取消并延后更新，卸载时清理。
- 每个 Markdown 组件维护独立解析状态。已稳定的块保留 AST 引用，末尾两个块仍重新解析，以容纳未写完的列表标记、表格和 setext 标题等变化。渲染层为块增加 memo，DOM 结构和样式不变。
- 定义、引用式链接、脚注可能回头改变已有块，发现后立即回退全文解析。来源或链接开关变化、正文替换、消息切换均使缓存失效。值相同的来源数组不会清缓存。
- 完成状态强制一次完整解析作为最终校准。不会用尾部缓存替代完整结果。现有 LLM math 扩展在 `\[` 后接换行和制表符等未闭合输入上可能抛异常，此时回退普通 GFM；下一次输入继续尝试原公式解析。

验证（在 chat-demo 目录运行，使用 Node 24+ 的 registerHooks 和类型剥离；当前验证环境为 Node 26）：

```sh
node --test --import ./src/services/markdown/test-register.mjs ./src/services/markdown/incremental.test.mjs

CHROME_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node --test ./src/components/markdown/useThrottleMarkdownRender.browser.test.mjs

./node_modules/.bin/oxlint src/components/markdown src/services/markdown
```

浏览器测试复用仓库 tools 目录已有 Playwright，不引入应用依赖，不启动服务器。可通过 `CHROME_EXECUTABLE_PATH` 指向系统 Chrome；未设置时使用 Playwright 默认浏览器。

解析用例逐字符比较完整 AST（包括位置），覆盖代码、Mermaid、公式、列表、引用、表格、HTML、链接/citation、迟到定义、CRLF、替换及选项变化；另有混合语法、稳定引用和结束校准测试。浏览器用例在 390×844 与 820×1180 视口验证分段增长、完成同步刷新、替换、换消息、定时器清理，并验证持续输入、长尾节流、减少动态效果。

性能用例为 10,820 字符、113 次更新，包含最终完整校准。全文解析累计处理 629,128 字符，增量处理 25,506 字符，减少 95.9%。耗时由每次测试打印，仅作为本机解析工作量比较，不等同于真实设备帧率或整页性能。
