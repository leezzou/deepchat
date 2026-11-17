# 主会话任务：首页 + 输入卡片 + Android 壳（P0）

首页是「像不像」的第一屏。以下数值全部来自 `reference/UI-SPEC.md`（1080×2400 截图 ÷2.625 = CSS px，视口 411×914）。

## A. 首页空态

文件：`src/components/session/Welcome.tsx`、`Welcome.module.css`、`SessionView.module.css`

现状：`Welcome.module.css:53-56` 用 `.greeting { margin: auto 0 }` 把纯文字居中，无 logo，无品牌感。

目标：
1. 垂直居中偏上（不是正中）：logo 视觉尺寸 ~48×36，logo 中心 y≈414dp；问候语 24px/600、`#0F0F0F`（深色 `#F8F8F8`），与 logo 间距 8px，文字 `欢迎回来，想从哪里开始？`（可配置常量；APK 兜底文案是 `今天有什么可以帮到你？`）。
2. logo：自绘内联 SVG 蓝色鲸鱼（#426EFE，允许近似，不要直接搬官方 logo 资源文件），放 `src/components/base/` 或 Welcome 内部。
3. 空态下**没有**建议 chips、没有副标题、没有底部 tab bar。
4. 输入卡片固定在底部（见 B），首页与会话页共用。

## B. 输入卡片（`src/components/chatInput/ChatInput.tsx` + `ChatInput.module.css`）

| 项 | 目标值 |
|---|---|
| 外距 / 宽 | 左右 12px（卡片宽 386dp） |
| 圆角 | 24px |
| 背景/描边 | #FFFFFF + 1px #F0F0F0；深色 #242424 + 1px #333333；极淡外阴影 |
| 行 1 | 单行 EditText，左内 15px，16px，占位 `发消息或按住说话` / #B9BABB |
| 行 2 | 距卡片底 13px：左 chip、右 ⊕ + 语音/发送 |
| chip | 高 29px、全圆角、内边距 12px、16px 图标 + 6px + 13px/500 |
| chip 激活 | 无边框、底 #EDF3FE、字/图标 #426EFE（深色 #283142 / #6392F2） |
| chip 未激活 | 白底、1px #EDEDED、字 #4B4B4B（深色 #474849 / #F8F8F8） |
| 默认态 | 深度思考=关、智能搜索=开 |
| 右侧图标 | 24px 描边 2px；⊕ 中心距卡片右缘约 27px；语音同理 |
| 有文字时 | 语音键 → 28–32px 蓝色实心圆 `#426EFE` + 白色 ↑（`app-36-input-typed-dark.png`） |
| 卡片下 | 会话页才有 `回答由 AI 生成，仅供参考` 11px #DDDDDD 居中，卡片下 5px |

其他：`enterkeyhint="send"`、`inputmode` 保持；多行时卡片自动长高；键盘弹起时卡片贴键盘（Android 由 `adjustResize` 处理，**必须在原生平台禁用** `src/app/viewport.ts:71-75` 的 visualViewport 补偿，否则双倍上移）。

## C. Header（`src/components/session/MobileHeader.tsx` + `MobileHeader.module.css`）

- 高 56px，无标题文字、无分隔线、无阴影。
- 左：`≡` 双横线图标（上长下短、2px 圆头、24px 盒、左内 13px），点开抽屉。
- 右：`自动朗读` 开关（斜杠喇叭=关 / 喇叭=开，24px）+ `⊕💬 开启新对话`（24px），最右距屏 11.4px。
- 会话页：`≡` 右侧加会话标题 16px/600，左内 57px，单行省略。
- 深色模式图标 `#F8F8F8`。

## D. i18n 新增 key（主会话统一改 `src/i18n/zh.ts` + `en.ts`）

`welcomeGreeting`（欢迎回来，想从哪里开始？）、`inputPlaceholderVoice`（发消息或按住说话）、`autoReadAloud`（自动朗读）、`smartSearch`（智能搜索，若与现有 `联网搜索` 语义不一需并置）、`drawerSearchPlaceholder`（搜索对话内容...）、`settingsAccount`（账户）、`settingsDataManagement`（数据管理）、`settingsAppearance`（外观）、`settingsVoice`（语音）、`settingsAbout`（关于）、`settingsHelpFeedback`（帮助与反馈）、`settingsSignOut`（退出登录）、`appearanceFollowSystem`（跟随系统）、`appearanceLight`（浅色）、`appearanceDark`（深色）。
> agent 并行期间禁止它们改 i18n，最后由主会话一次性收敛（agent 用中文字面量 + 报告列出）。

## E. Android 壳（`chat-demo/android/` + 新增 `src/shell/native.ts`）

依赖（用 `--registry=https://registry.npmmirror.com` 装）：
`@capacitor/status-bar@6`、`@capacitor/app@6`、`@capacitor/browser@6`、`@capacitor/filesystem@6`、`@capacitor/share@6`

1. **状态栏**：不透明、颜色=页面底色（白 / #0F0F0F），主题切换时 `StatusBar.setStyle` + `setBackgroundColor`；导航栏同理。
2. **返回键分层**：`App.addListener('backButton')` → 依次关闭 抽屉 / 设置页 / 弹窗 / 图片预览，都没有则 `App.exitApp()`。实现：`src/shell/native.ts` 暴露 `pushLayer(close)/popLayer`，组件挂载时注册。
3. **外链**：全局 click 拦截 `a[href^="http"]` → `Browser.open()`（否则 `target=_blank` 在 WebView 里静默失败）。
4. **Blob 下载**：`SettingsDialog.tsx:527-532` 的导出 ZIP 在 WebView 静默失败 → blob → base64 → `Filesystem.writeFile({ directory: Directory.Documents })` → `Share.share()`。
5. **麦克风**：Manifest 加 `RECORD_AUDIO`、`CAMERA`、`READ_MEDIA_IMAGES`；`MainActivity.onCreate` 首次运行申请 RECORD_AUDIO（否则 `getUserMedia` 必失败）。
6. **键盘**：`windowSoftInputMode="adjustResize"`；去掉 Web 端 visualViewport 补偿（见 B）。
7. **交互细节**：`overscroll-behavior: none`、`-webkit-tap-highlight-color: transparent`、`input` 字体 ≥16px 防放大、长按不弹系统菜单。
8. **图标/启动图**：自绘鲸鱼 ic_launcher（蓝底白鲸），`AppTheme.NoActionBarLaunch` 用纯色/居中 logo，不要 Capacitor 默认 splash。
9. `.gitignore`：`android/.gradle`、`android/app/build`、`android/local.properties`、`android/app/src/main/assets/public`。

## F. 验证闭环（每次改完）

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
cd chat-demo && pnpm build && npx cap sync android
cd android && ./gradlew assembleDebug --no-daemon
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.deepseek.demo.shell/.MainActivity
adb exec-out screencap -p > /tmp/home.png   # 与 reference/app-20-home.png 逐项比对
```
