# 交接文档：把 deepseek-ai/chat-demo 包成安卓 App（对齐手机版 DeepSeek）

更新时间：第 2 轮结束时
一句话状态：**壳已跑通（debug APK 能装能跑、状态栏/导航栏已对齐）；首页 P0 完成并按实测像素校准到 ±1px；抽屉、消息区由并行 agent 改完；设置页 agent 收尾中。**

---

## 1. 目标与验收标准

用户原话（2025-…，m00001）：

> https://github.com/deepseek-ai/chat-demo
> 把这个包装成一个安卓app，界面和使用要对齐手机版deepseek的app
> 这是deepseek明确说的允许的，不算抄袭

补充（m00026）：

> 使用体验要跟手机app一样，只是比手机多了用api的方式

因此：

1. **UI/交互** 对齐官方 App `com.deepseek.chat` v2.8.0（不复制其登录体系）。
2. **能力** 保留本仓库的 API Key 方式（不登录，填 Key 直接用）。
3. **交付** 能装到 Android 手机上的 APK + 一页 README 说明（免责声明：非官方客户端）。

---

## 2. 当前状态看板

| 项 | 状态 | 说明 |
|---|---|---|
| Web 端构建 | ✅ | `pnpm build` 通过（rspack，1s）；`pnpm type` 通过 |
| 官方 App 逆向/量测 | ✅ | 官方 APK 装进模拟器，36 张真机截图 + 205 行实测规范 |
| 现有 Web 端移动 UI 审计 | ✅ | `UI-AUDIT.md`，520 行，带 file:line 与 P0/P1/P2 |
| Capacitor 工程 | ✅ | `chat-demo/android/`，appId `ai.deepseek.demo.shell` |
| Gradle 下载/镜像 | ✅ 已验证 | wrapper → 腾讯镜像；Maven → 阿里云镜像；**`settings.gradle` 的 `pluginManagement` 必须放在文件最前面**（第 2 轮踩坑） |
| 首次 `assembleDebug` | ✅ | 2 分 12 秒出包；增量构建 10–20s |
| 装到模拟器 | ✅ | `adb install -r` 成功，WebView 正常渲染 |
| 首页 P0（logo/问候/header/输入卡片） | ✅ | 与 `reference/app-20-home.png` 逐项比对，纵向误差 ≤1px（见 §12） |
| 抽屉 | ✅ agent 改完 | 310dp、右缘 16dp 圆角、92% 白遮罩、48dp 搜索胶囊、底部头像+⋯ |
| 消息区 | ✅ agent 改完（静态验证） | 无 API Key，只能在浏览器里靠静态推演，运行期未验证 |
| 设置页（整页化） | ✅ agent 改完 | 整页 220ms 滑入、56px 顶栏、分组卡片 16dp/46dp 行、外观二级页；桌面端弹窗不变 |
| 壳层能力 | 🔄 部分完成 | ✅ 状态栏/导航栏配色（含深色导航栏，走原生桥）、返回键分层、外链走系统浏览器、adjustResize、权限声明；⏳ 麦克风运行时申请、Blob 下载、图标/启动图 |
| 多 API 配置（多 Key / 自定义 Base URL） | ✅ | 服务商预设 + OpenAI 兼容适配层，见 §13 |
| 从 DeepSeek 导入 | ✅ | 粘贴官方「导出数据」的链接，App 下载并导入 |
| 麦克风运行时权限 | ✅ | 原生桥 `requestMicrophone()` + `window.__onMicPermission` |
| 导出 ZIP 下载 | ✅ | 原生写入 Cache + 系统分享（`saveFile.ts`） |
| 图标、release 签名 | ✅ | 自绘鲸鱼自适应图标 + 自签 keystore 出 `app-release.apk` |
| 消息区真机验证 | ✅ | 用真实 Key 跑通对话，操作行在触屏上常显 |

---

## 3. 目录与产物

```
~/project/chat/
├── HANDOFF.md                  # 本文
├── UI-AUDIT.md                 # 现有 Web 端移动端审计（P0/P1/P2 + i18n 键清单）
├── reference/                  # 官方 App 量测资料（取证材料，勿删）
│   ├── UI-SPEC.md              # ★ 实测 UI 规范（tokens/圆角/字号/各屏布局/未验证项）
│   ├── deepseek.apk            # 官方 APK v2.8.0(297)，22MB，腾讯应用宝下载
│   ├── app-01…app-36*.png      # 真机截图（1080×2400，density 2.625）
│   ├── ui-*.xml                # uiautomator 控件树（含 bounds）
│   ├── web-*.png / demo-*.png  # 网页版对照
│   └── store-shot-*/play-shot-*# 应用商店宣传图
├── tools/                      # playwright（审计/截图用，已装好）
└── chat-demo/                  # 上游仓库 fork（MIT）
    ├── capacitor.config.json   # 新增
    └── android/                # 新增（Capacitor 6 平台工程）
```

`chat-demo` 内**源码零改动**，唯一改动是 `package.json` / `pnpm-lock.yaml`（新增 `@capacitor/core@6.2.3`、`@capacitor/android@6.2.3`、`@capacitor/cli@6.2.3`）。

---

## 4. 环境与可复制命令

```bash
# 必须用 JDK 17（系统默认是 JDK 27，AGP 8.2.1 会挂）
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

# Android SDK
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
# 已装 platforms: android-34 / android-36；build-tools: 34.0.0 / 35.0.0
```

构建 & 装机：

```bash
cd ~/project/chat/chat-demo
pnpm build                       # dist/
npx cap sync android             # dist → android/app/src/main/assets/public
cd android
./gradlew assembleDebug --no-daemon   # 首次 slow，产物 app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.deepseek.demo.shell/.MainActivity
adb exec-out screencap -p > /tmp/app-home.png
adb logcat -s Capacitor:V chromium:V | head -50     # WebView 报错看这里
```

模拟器（已在线，若需要重启）：

```bash
$HOME/Library/Android/sdk/emulator/emulator -avd Pixel_7_API_34_arm64 \
  -no-snapshot-load -no-boot-anim -gpu swiftshader_indirect &
# 官方 App 已安装：com.deepseek.chat（可随时截图对照）
adb shell monkey -p com.deepseek.chat 1
```

依赖安装（国内网络）：

```bash
pnpm add --registry=https://registry.npmmirror.com <pkg>
```

Web 预览（浏览器里做 UI 迭代，比装 APK 快）：

```bash
cd chat-demo && pnpm build && python3 -m http.server 8099 --directory dist
# 412×915 @2.625 截图脚本见 §10 各任务说明
```

---

## 5. 已做的技术决策（及原因）

1. **用 Capacitor 6，不用 7/8**：已装 SDK 是 `android-34` + JDK 17，Capacitor 6 的 `variables.gradle` 正好是 compileSdk 34 / targetSdk 34 / AGP 8.2.1，零额外下载；Capacitor 7 需要 compileSdk 35 + JDK 21。
2. **配置写成 `capacitor.config.json` 而不是 `.ts`**：仓库依赖 `typescript@7.0.2`，`@capacitor/cli@6` 的 TS 配置加载器会崩：
   `TypeError: Cannot read properties of undefined (reading 'CommonJS')`。用 JSON 绕开。
3. **Gradle 走镜像**：`services.gradle.org` 下载超时（`Download.downloadInternal` 中断），已把 `distributionUrl` 改成 `https://mirrors.cloud.tencent.com/gradle/gradle-8.2.1-all.zip`；`settings.gradle` 的 `pluginManagement` 与根 `build.gradle` 的 repositories 前置了 `maven.aliyun.com/repository/{google,public,gradle-plugin}`。
4. **不复制登录**：官方 App 的登录/账号体系不复刻，直接沿用 Web 端「填 API Key 即用」的路径；设置页保留「API Key」入口。
5. **状态栏策略（待实施）**：不走 edge-to-edge，而是状态栏/导航栏**不透明、颜色 = 页面底色**（浅色 #FFFFFF / 深色 #0F0F0F），用 `@capacitor/status-bar` 跟随主题切换图标深浅。原因：Android 14 WebView 不原生支持 `env(safe-area-inset-*)`，自己注入 inset 成本高；官方 App 头部本身也是纯白，视觉差异极小。
6. **appName = `DeepSeek`，appId = `ai.deepseek.demo.shell`**（不占用官方包名，避免任何冒充/覆盖安装的风险）。

---

## 6. UI 对齐清单（对齐 `reference/UI-SPEC.md`）

### P0（第一屏就能看出像不像）

| # | 内容 | 目标文件 | 现状 → 目标 |
|---|---|---|---|
| 1 | 首页空态：logo + 问候语垂直居中偏上（logo 中心 ≈ 414dp，问候 24px/600，#0F0F0F），无副标题 | `src/components/session/Welcome.tsx` + `.module.css` | 现为 `.greeting{margin:auto 0}` 纯文字居中，无 logo → 加鲸鱼 logo（可内联 SVG 临摹，勿用官方图标文件）、问候语上移 |
| 2 | Header 56dp、纯图标、无分隔线：左「双横线」菜单、右「自动朗读（斜杠喇叭）」+「⊕💬 新对话」 | `src/components/session/MobileHeader.tsx` + `.module.css` | 现为文字标题「API 使用 demo」+ 折叠图标 → 换图标、去文字 |
| 3 | 输入卡片：左右 12px、圆角 24px、1px #F0F0F0、两行布局；第二行左侧 chip、右侧 ⊕ 与语音键；**有文字时语音键变 28–32px 蓝色实心圆 + 白 ↑** | `src/components/chatInput/ChatInput.tsx` + `.module.css`、`VoiceButton.tsx` | 现 24px 圆角 + 三层阴影、toggle 透明胶囊、send 34px 蓝圆 → 按 spec 重排 |
| 4 | chip：高 29px 全圆角；**激活态去边框**、底 #EDF3FE、字/图标 #426EFE；未激活白底 + 1px #EDEDED + #4B4B4B | 同上 | 现状透明底 → 改 |
| 5 | 占位文案 `发消息或按住说话`；默认 深度思考=关、智能搜索=开 | `src/i18n/zh.ts`（新增 key）| 现为 `给 DeepSeek 发送消息` → 改 |
| 6 | 抽屉：宽 310px（75vw）、右缘 16px 圆角、48px 搜索胶囊 #F5F5F5、日期分组 13px #8E9094、行高 46px、底部「头像+用户名+⋯」、**没有新建入口、没有折叠按钮**、遮罩近不透明 + 250ms 滑入 | `src/components/sider/*` | 现 300px 面板 + 透明遮罩 + 无过渡 + 标题「API 使用 demo」 |

### P1

| # | 内容 | 目标文件 |
|---|---|---|
| 7 | 用户气泡：右对齐、右留 16px、最大 70%、#EDF3FE、18px 圆角、内边距 12/10 | `src/components/messages/UserMessage.tsx` + css |
| 8 | 助手消息：无气泡、左右 22/20px 通栏、16px/1.6、段距 12px | `src/components/messages/AssistantMessage.tsx` + css |
| 9 | 操作行：**触屏常显**（现在 `opacity:0` 只在 hover 显示，手机上看不见 —— 最大体验 bug）、20px 图标 #8E9094、顺序 复制/赞/踩/朗读/分享…重新生成 | `src/components/messages/*` |
| 10 | 设置页改「原生整页」：底 #F8F8F8、56px 顶栏 + 40px 圆形返回键 #EDEDED、分组卡片 16px 圆角、行高 46px、分组标题 13px #8E9094；外观做二级页（跟随系统/浅色/深色 + 蓝色 ✓） | `src/components/settings/*` |
| 11 | `viewport-fit=cover` + 安全区 | `src/index.html:5` |
| 12 | 关掉 iOS 专属样式的移动端副作用、去 hover-only 交互 | 相关 css |

### P2

- 会话页 header 显示会话标题（16px/600，左 57px）
- 滚动到底部按钮：40px 白圆 + 阴影，右 20px、输入卡片上方 16px
- 免责声明 `回答由 AI 生成，仅供参考` 11px #DDDDDD 居中，卡片下 5px
- 深色模式逐项对齐（#0F0F0F 页面 / #242424 卡片 / #283142 气泡 / #333333 描边）

---

## 7. 壳层（Android）待办

按价值排序，全部在 `chat-demo/android/` + 一个 `src/shell/native.ts`：

1. **状态栏/导航栏**：装 `@capacitor/status-bar`，主题切换时 `setStyle(Dark/Light)` + `setBackgroundColor`；`android/app/src/main/res/values/styles.xml` 里 `AppTheme.NoActionBar` 去掉 actionbar 阴影、`windowBackground` = 白（深色 = #0F0F0F），`AppTheme.NoActionBarLaunch` 用纯色 splash（不要 Capacitor 默认启动图）。
2. **返回键分层**：`@capacitor/app` 的 `backButton` → 先关抽屉/弹窗/二级页（组件注册一个 `pushLayer/popLayer` 栈），否则 `App.exitApp()`。现状：默认直接退出 App，抽屉开着也退。
3. **外链**：`@capacitor/browser` + 全局 click 拦截 `a[href^=http]` → `Browser.open`（现在 `target=_blank` 链接会在 WebView 里裸开/无反应，来源卡片、站外链接会坏）。
4. **Blob 下载（导出历史 ZIP）**：WebView 里 `a.download` + `blob:` 静默失败（`SettingsDialog.tsx:527-532`）→ 用 `@capacitor/filesystem` + `@capacitor/share`：blob → base64 → 写 `Documents/` → 系统分享。
5. **麦克风/拍照**：`AndroidManifest.xml` 加 `RECORD_AUDIO`、`CAMERA`、`READ_MEDIA_IMAGES`、`POST_NOTIFICATIONS`(可省)；`MainActivity.onCreate` 首次启动申请 `RECORD_AUDIO`，否则 `getUserMedia` 在 WebView 里必失败（`src/services/speech/recorder.ts`）。`<input type=file accept>` 走系统选择器（`src/services/uploadExts.ts` 里 700 个后缀的 accept 串，Android 上会退化成「所有文件」，建议按 files/images 两类简化）。
6. **键盘**：`android:windowSoftInputMode="adjustResize"`（Capacitor 默认）；**务必去掉 Web 端基于 `window.visualViewport` 的键盘补偿**（`src/app/viewport.ts:71-75`），否则双倍上移。
7. **交互细节**：禁掉 WebView 下拉回弹与 tap 高亮（`overscroll-behavior:none`、`-webkit-tap-highlight-color:transparent`）、`user-select` 只在消息正文放开、长按链接不弹系统菜单（原生 `WebView.setOnLongClickListener` 或 CSS）。
8. **图标/名称**：`@mipmap/ic_launcher` 换成自绘鲸鱼（蓝 #426EFE，别直接用官方 logo 文件），`strings.xml` 的 `app_name`/`title_activity_main` 已是 DeepSeek。
9. **Release**：`signingConfigs` + `assembleRelease`，或先只出 debug APK 给用户装。

---

## 8. 已知坑（踩过的，别再踩）

- **JDK**：系统默认 `openjdk 27` → AGP 8.2.1 直接失败。永远 `export JAVA_HOME=.../openjdk@17/...`。
- **Capacitor TS 配置**：`capacitor.config.ts` 会崩（TS 7 不兼容 cli 6），必须用 `.json`。
- **Capacitor CLI 需要联网**：`cap add android` 会尝试跑 gradle sync 并下载 wrapper；下载失败会打印一大坨 Java 栈但**工程仍是成功的**（结尾有 `[success] android platform added!`）。
- **`cap sync` 之后** assets/public 才是最新 dist；改完 Web 代码必须 `pnpm build && npx cap sync android`，否则看到的是旧页面。
- **无 API Key**：聊天页在浏览器/模拟器里渲染不出来（首页能看，会话页只能靠静态 CSS 推）。实测发现官方 App 的首页问候语是**服务端下发**，APK 兜底为 `今天有什么可以帮到你？`，登录态为 `欢迎回来，想从哪里开始？`；实现里应做成可配置常量。
- **官方 App 本版无建议 chips**（旧版 4 个建议卡已移除），不要加回去。
- `pnpm add` 不加 `--registry` 会走默认源，慢；`pnpm install` 的历史命令带了 `--frozen-lockfile`，新增依赖后别再带。
- **不要**把 `android/local.properties`、`node_modules` 提交到 git（`android/` 目前整体 untracked，提交前加 `.gitignore`：`android/.gradle`、`android/app/build`、`android/local.properties`、`android/app/src/main/assets/public`）。

---

## 9. UI-SPEC 关键数值速查（照抄即可）

```
品牌蓝 #426EFE    浅色页面 #FFFFFF   深色页面 #0F0F0F
一级文字 #0F0F0F / 深色 #F8F8F8      次级 #8E9094      占位 #B9BABB
发丝线 #F0F0F0    边框 #EDEDED       填充 #F5F5F5      深色卡片 #242424/边框 #333333
用户气泡 #EDF3FE / 深色 #283142      chip 激活底 #EDF3FE / 深色 #283142、字 #426EFE / #6392F2
设置页底 #F8F8F8 / 深色 #1E1E1E      设置卡片 #292929（深色）
圆角：输入卡片 24 / 气泡 18 / chip·pill 999 / 设置卡片 16
Header 56dp；抽屉 310dp；抽屉搜索胶囊 48dp；抽屉行高 46dp；设置行高 46dp
首页问候 24sp/600；正文 16sp/1.6；抽屉项 16sp；分组标题 13sp；chip 13sp/500；免责 11–12sp
输入卡片左右 12px；助手消息左右 22/20px；用户气泡右 16px、最大 70%
```

---

## 10. 下次开工的推荐顺序

1. `export JAVA_HOME=<jdk17>` → `pnpm build` → `npx cap sync android` → `./gradlew assembleDebug --no-daemon` → 装机 → 截一张基线图。**先确认壳能跑通，再动 UI。**
2. 首页 P0（Welcome / MobileHeader / ChatInput）—— 决定「像不像」的第一屏。
3. 抽屉 / 设置 / 消息行可以三路并行（文件互不重叠，i18n 由主会话统一改，避免冲突）。三个 agent 任务说明已整理在 `handoff/agent-tasks/`，直接照抄给 agent 即可。
4. 壳层能力 §7（1–6）。
5. 图标 + 应用名 + 启动图 + release APK + README（含免责声明与安装说明）。

### 并行 agent 的协作约定（重要）

- 三个任务的文件范围严格互斥：`components/sider/*`、`components/settings/*`、`components/messages/*`；主会话负责 `components/session/*`、`components/chatInput/*`、`src/index.html`、`src/i18n/*`、`src/shell/*`、`android/*`。
- **agent 不许改 `src/i18n/*`**（并发写同一文件会互相覆盖）：需要新文案时用中文字面量 + 报告里列出，由主会话统一收敛到 i18n。
- 每个 agent 结束前必须：`pnpm build` 通过、`pnpm type` 通过（新增 CSS 类要同步补 `*.module.css.d.ts`）、截图到 `/tmp/` 对照 `reference/app-*.png` 至少迭代两轮。
- 官方 App 在模拟器里随时可截图取证：`adb exec-out screencap -p > /tmp/official.png`。

---

## 11. 参考：本次会话的取证结论（UI-SPEC 摘要，避免重复劳动）

- 官方首页：Header 56dp（左 ≡ 24dp 双线，右 喇叭 + 气泡加号，无标题无分隔线）；中部 logo（蓝鲸，~48×36dp）+ 24sp 问候；底部输入卡片两行（占位 + chip 行 + ⊕/语音）。
- chip 默认态：深度思考=关，智能搜索=开（蓝底蓝字，无边框）。
- 有输入文字时：语音键 → 28–32dp 蓝色实心圆 + 白色 ↑。
- 抽屉：310dp 宽、搜索胶囊在顶、按「年-月」倒序分组、行 46dp、底部头像+⋯；**无新建入口**。
- 会话页：用户右侧 #EDF3FE 18px 气泡；助手无气泡 22px 边距 16px/1.6；操作行 `复制/赞/踩/朗读/分享 … 重新生成`，色 #8E9094。
- 设置页：整页 + 40px 圆形返回 + 分组卡片（账户/应用/语音/关于/帮助反馈/退出登录）。
- **未取证**（无登录/无 API Key）：停止生成按钮、重新生成菜单、搜索来源卡、深度思考折叠块、附件消息、语音录制浮层、长按菜单、多选模式。

---

## 12. 第 2 轮进展（壳跑通 + 首页 P0）

### 12.1 壳：从「打不出包」到「装得上、看得出」

1. **构建失败根因**：上一轮把阿里云镜像塞进 `android/settings.gradle` 时，`pluginManagement {}` 被写在了 `include` 之后。
   Gradle 8.2.1 要求它**必须是文件里的第一个语句**。修复 = 把 `pluginManagement` 整块提到最前面。
2. 首次 `assembleDebug` 2 分 12 秒通过（Gradle 8.2.1 all + AGP 8.2.1 从镜像下载完毕）。
3. **状态栏/导航栏**原来是一条灰 + 一条黑（系统默认色）。改法：
   - `res/values/colors.xml`：`page_background = #FFFFFF`；`res/values-night/colors.xml`：`#0F0F0F`
   - `res/values/bools.xml` / night 版：`page_background_is_light`
   - `AppTheme.NoActionBar` 里加 `android:statusBarColor`、`navigationBarColor`、`windowLightStatusBar`、`windowLightNavigationBar`、`windowBackground`
   - `AppTheme.NoActionBarLaunch` 改成纯色底（去掉 Capacitor 默认 splash 图）
   - 运行时由 `src/shell/native.ts` 的 `useNativeShell()` 跟随 Web 主题调 `StatusBar.setStyle/setBackgroundColor`
4. **权限/键盘**：`AndroidManifest.xml` 加 `RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`、`CAMERA`、`READ_MEDIA_IMAGES`、`READ_EXTERNAL_STORAGE(maxSdk=32)`；Activity 加 `windowSoftInputMode="adjustResize"`。
5. **Web 侧壳层**（新增 `src/shell/native.ts`）：
   - `isNative` / `PAGE_BACKGROUND`
   - `pushLayer(close)/popLayer` 返回键分层栈，未注册层时兜底关闭设置页 → 抽屉 → `App.exitApp()`
   - 全局 click 拦截 `a[href^=http]` → `@capacitor/browser`
   - `useNativeShell()` 在 `App.tsx` 里挂载；同时把 `useMobileViewport(isMobile && !isNative)` 关掉，避免与 `adjustResize` 双倍上移
6. 新装依赖：`@capacitor/status-bar@6`、`@capacitor/app@6`、`@capacitor/browser@6`。

### 12.2 首页 P0：按截图反推的真实数值（覆盖 spec 里的两处笔误）

用「截取真机图 → 逐行扫描墨迹 → 与实现截图比 delta」的办法校准，最终纵向误差 ≤1px：

| 元素 | 实测 app-20-home.png | 实现值 |
|---|---|---|
| 鲸鱼 logo | y 1048–1127（中心 414dp），蓝区 104×79px | `.logo` 44×33px，`padding-bottom: 3px` 居中微调 |
| 问候语 | y 1192–1241，字宽 573px | **20px/700**、行高 28px、与 logo 间距 19px |
| header 图标 | y 176–225 | 56px 高，`padding: 0 1px 0 3px`，图标 24px |
| 输入卡片 | 2032–2294（100dp 高） | 底 16px、左右 12px、圆角 24、`1px #F0F0F0` |
| 占位文字 | y 2085（距卡片顶 ~20dp 墨迹） | `.textarea` `padding: 17px 15px 0` |
| chip 行 | 框 2188–2264、高 29dp、宽 94dp | `padding: 18px 12px 12px`、chip 高 29、内边距 11、图标 16、间距 5 |
| ⊕ / 语音 | 中心 329dp / 372dp | `.right { gap: 13px }`，按钮盒 29px、图标 24px |

> ⚠️ **spec 里两处数值与截图不符，已按截图实现**：
> 1. 问候语不是 24sp，实测字宽 573px / 12 个字 ≈ 18.2dp → **20px/700**；
> 2. `深度思考` chip 内边距不是 12dp，实测 ≈11dp（整颗 chip 94dp 而非 97dp）。

其余首页要点：
- 新增 `src/components/base/WhaleLogo.tsx`（自绘近似蓝鲸，`fill-rule=evenodd` 挖出弯月与眼睛，深浅色底都成立）。
- `MobileHeader` 换成官方三件套：双横线菜单 / 自动朗读开关（喇叭有无斜杠）/ 开启新对话（气泡+号）；会话页在菜单右侧显示标题。
- 新增设置项 `autoRead`（`chat-demo:auto-read`），默认关。
- **智能搜索默认改为开**（`read(KEYS.search) !== 'false'`）。
- `i18n` 新增 `welcomeGreeting`、`autoReadAloud`；`contentCaveat` 改为官方文案 `回答由 AI 生成，仅供参考`；占位符改为 `发消息或按住说话`。
- 输入卡片：有文字时语音键让位给 28–30px 蓝色实心发送键（白色 ↑）；⊕ 由纸别针 icon 换成圆圈加号。

### 12.3 设置页 / 抽屉 / 消息区（agent 交付）

- **设置页**：移动端改成整页（z-index 900、220ms 右滑入、`#F8F8F8`/`#1E1E1E`），56px 顶栏 + 40px 圆形返回键，
  分组卡片 16dp 圆角 / 16dp 边距 / 46dp 行高，分组标题 13/500 `#8E9094`。分组 = 账户（API Key 管理、数据管理）、
  应用（语言、外观、位置信息）、语音（朗读音色）、关于（版本号）、帮助与反馈、清除数据；`外观` 是二级页（跟随系统/浅色/深色 + 蓝色 ✓）。
  桌面端仍是原来的弹窗，未动。
- **抽屉**：310dp 宽、右缘 16dp 圆角、`rgba(255,255,255,.92)` 遮罩、48dp 搜索胶囊、底部头像 + 用户名 + ⋯、无新建入口。
- **消息区**：用户气泡 70%/18dp/`#EDF3FE`；助手通栏 22/20px；操作行用 `@media (hover:none)` 常显，桌面仍是 hover 才出现。
- **交互修正**：打开设置页时收起抽屉（否则关掉设置会落回抽屉）。

### 12.4 深色模式的一个坑：导航栏

`StatusBar.setBackgroundColor` 只管状态栏，**导航栏没有 Capacitor 插件**，只靠 `values-night` 会跟系统深色走，
导致「App 内切深色、系统是浅色」时底部留一条白条。解法：
- 新增 `android/.../SystemBars.java` + `MainActivity` 里 `addJavascriptInterface(new SystemBars(this), "AndroidSystemBars")`；
- `src/shell/native.ts` 的 `syncSystemBars()` 先调 `window.AndroidSystemBars.setDark(dark)`，再调 `StatusBar.setStyle`。

### 12.5 仍待办（按价值排序）

1. 消息区只有静态验证，有 API Key 后要在真机上过一遍操作行常显。
3. 麦克风运行时权限（`MainActivity.onCreate` 首次申请 `RECORD_AUDIO`），否则 `getUserMedia` 在 WebView 里必失败。
4. 导出历史 ZIP 的 Blob 下载在 WebView 里静默失败 → `@capacitor/filesystem` + `@capacitor/share`。
5. 图标（自绘鲸鱼 `ic_launcher`）、release 签名、README（免责声明：非官方客户端）。
6. 断言用脚本（可选）：`tools/` 下写个截图比对脚本，把上面那张表的 delta 固化下来，防止回归。

---

## 13. 第 3 轮：多 API 配置 / 导入 / 图标 / 签名

### 13.1 多 API 配置（参考 harness 的用法）

原来是「一个 Key 一个地址」，现在改成**配置列表**：每条有 `名称 / 协议 / 接口地址 / 模型 / Key`，
点一行即切换，设置里可增删改。

- `src/services/api/origin.ts`：运行时的 `{origin, protocol, model}`，`setApiConfig()` 由设置层写入。
- `src/services/settings.ts`：`apiProfiles: ApiProfile[]` + `activeProfileId`，旧版 `chat-demo:api-key` 自动迁移成一条配置。
- **两种协议**：
  - `deepseek`（默认）：`POST {origin}/anthropic/v1/messages`，附带的 Files API、搜索工具、TTS/ASR 都可用；
  - `openai`：`POST {origin}/chat/completions`，把 `chat.completion.chunk` 增量翻译成同一套 `MessageStreamEvent`，
    上层 `applyEvent` 与渲染逻辑零改动。
- 服务商预设（填完地址/模型，用户只填 Key）：

  | 预设 | 协议 | 接口地址 | 模型 |
  |---|---|---|---|
  | DeepSeek 官方 | deepseek | `https://api.deepseek.com` | 内置 `deepseek-flash` |
  | 智谱 GLM | openai | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` |
  | SiliconFlow | openai | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3.2-Exp` |
  | OpenRouter | openai | `https://openrouter.ai/api/v1` | `z-ai/glm-4.6` |
  | 自定义 | openai | 手填 | 手填 |

- 已知限制：`openai` 协议下**附件上传与语音输入/朗读不可用**（这些依赖 DeepSeek 的 Files API 与 TTS/ASR），
  界面上会给出提示；历史里已有的附件在 `openai` 协议下会被跳过。

### 13.2 从 DeepSeek 导入

官方 App 的「导出数据」给的是一个 **7 天有效的下载链接**（不是本地文件），所以做法是：
数据管理页新增「从 DeepSeek 导入」，把链接粘进去 → `fetch` 下载 → 当成 ZIP 走原有的导入确认流程。
失败（链接过期 / 跨域被拦）会提示改用本地 ZIP 导入。

### 13.3 壳层补齐

- **麦克风**：`SystemBars.requestMicrophone()` + `MainActivity.onRequestPermissionsResult` 回传
  `window.__onMicPermission(granted)`；点语音输入时才申请，不再一启动就弹。
- **导出下载**：`src/shell/saveFile.ts` —— 原生下 blob 写入 `Directory.Cache` 再 `Share.share()`，
  浏览器仍是 `a[download]`。

### 13.4 图标与签名

- 启动图标：自绘鲸鱼（与 Web 端同一路径）白色前景 + `#426EFE` 底，`mipmap-anydpi-v26` 走自适应图标，
  同时用 Playwright 渲染了 mdpi–xxxhdpi 的 legacy PNG（含圆形）。
- 签名：`android/app/deepseek-demo.jks` + `android/keystore.properties`（都已进 `.gitignore`）；
  `assembleRelease` 产出 `deepseek-demo.apk`（4.7MB，`apksigner` 校验通过）。

### 13.5 这一轮真机验证过的

- 首页/抽屉/设置（浅色 + 深色）、API 配置列表与表单、服务商预设自动填参；
- **真实对话**：填 Key → 自动生成会话标题 → 用户气泡 / 助手正文 / 操作行全部正常，操作行在触屏上常显；
- 启动器图标显示的是蓝色鲸鱼。

### 13.6 还没做的

- 助手操作行只有 `复制 / 朗读 / 重新生成`；官方还有 `赞 / 踩 / 分享` —— 需要服务端接口（反馈、分享链接），
  本 App 没有对应 API，没有硬造按钮。
- `openai` 协议下的附件与语音能力缺失（见 13.1）。
- 导入链接若被跨域拦截只能退回本地 ZIP（官方下载域名是否带 CORS 头未验证）。

---

## 14. 第 4 轮：改名 DeepChat / 官方鲸鱼 / 36 个服务商预设

### 14.1 应用名 → DeepChat

改了四处：`capacitor.config.json` 的 `appName`、`res/values/strings.xml` 的 `app_name` /
`title_activity_main`、`src/index.html` 的 `<title>`、i18n 的 `appName`（抽屉里显示的那个）。
`aapt2 dump badging` 已确认 `application-label:'DeepChat'`。包名仍是 `ai.deepseek.demo.shell`（改包名会变成另一个 App，没动）。

### 14.2 鲸鱼换成官方图形

从 `reference/deepseek.apk` 里找到官方图标位图 `res/bK.png`（256×256，浅底 + 蓝鲸），
用脚本把浅底抠掉转成透明 PNG：

- 背景是 #F6F9FF 附近带极淡渐变 → 先按 `|px-bg|` 建 alpha，再减掉 14 的底噪（不去噪的话深色模式下会有一圈浅边）；
- 反预乘回去，避免缩放时出现白边；
- 结果存 `src/assets/deepseek-whale.png`（184×140），`WhaleLogo` 改成 `<img>`，首页渲染宽度 44px。

> 之所以不重新描摹：官方轮廓细节（嘴、鳍、眼睛的高低）手画容易走样，直接取位图去背最稳。
> `rspack.config.ts` 补了 `png|jpe?g|webp → asset/resource` 规则，`src/env.d.ts` 补了 `*.png` 声明。
> 旧的 `drawable/ic_launcher_foreground.xml`（手绘路径）已删除。

启动图标也用同一个鲸鱼重新生成：蓝底 + 白色鲸鱼剪影（`mipmap-*dpi/ic_launcher.png`、
`ic_launcher_round.png`、`ic_launcher_foreground.png`，自适应图标走 `mipmap-anydpi-v26`）。

### 14.3 服务商预设：36 个，地址全部实测

`SettingsDialog.tsx` 的 `providerPresets` 现在覆盖：

- **DeepSeek 官方**（deepseek 协议，附件/联网/语音全可用）
- 国内：智谱 GLM、GLM 国际、阿里云百炼、百炼国际、Kimi、Kimi 国际、硅基流动、火山方舟、百度千帆、
  腾讯混元、MiniMax、MiniMax 国际、阶跃星辰、讯飞星火、商汤日日新、百川
- 海外：OpenAI、Anthropic、Google Gemini（`/v1beta/openai`）、xAI、Mistral、Groq、Together、Fireworks、
  DeepInfra、Cerebras、SambaNova、Novita、OpenRouter、Perplexity、Cohere、**OpenCode Zen**
- 本机：Ollama（`:11434/v1`）、LM Studio（`:1234/v1`）
- 自定义

验证方式：对每个 `${origin}/chat/completions` 发一个假 Key 的请求，看返回码——
**401/403/400 说明端点存在**（鉴权/参数错误），404 说明路径不对，000 说明网络不通。实测结果：
- 保留：上表全部（含 `opencode.ai/zen/v1`，返回 401 ✅）
- 剔除：`api.lingyiwanwu.com`（410 Gone，服务已下线）、`integrate.api.nvidia.com`（404 page not found）、
  `api.hyperbolic.xyz`（端点已 decommissioned）
- 存疑但仍保留：`api.mistral.ai`（本机网络 000 超时，无法确认）

模型名只做默认值，表单里可改；选完预设只有 API Key 是必填。

### 14.4 这一轮的验证

- 启动器里显示 `DeepChat` + 蓝底白鲸图标；
- 首页 logo 就是官方鲸鱼（44×33）；
- 服务商下拉 36 项可滚动、选中后自动填地址与模型。

---

## 15. 第 5 轮：应用内更新 + 上下文压缩

### 15.1 应用内更新（不跳 GitHub 页面）

- `src/services/update.ts` 读仓库根目录的 `update.json`（raw.githubusercontent，避开 GitHub API 60 次/小时的限制），
  字段：`version / notes / pageUrl / apkUrl`。
- `src/shell/installer.ts` → `Updater.java`：原生 HTTP 下载 APK 到 cache，`FileProvider` + `ACTION_VIEW` 拉起系统安装器。
  已改为**显式指定系统「软件包安装程序」**，不再弹「打开方式」选择框（v1.0.2）。
- 首次安装仍需手动装一次 APK，之后所有版本都能在 App 内更新。
- 发版一键脚本：`scripts/release.sh 1.0.3 "说明"` → 改版本号 → 打包 → 刷新 update.json → 推送 → `gh release create`。

### 15.2 上下文压缩（照搬 DSH compaction-basic）

- 阈值 `thresholdRatio = 0.8`、保留 `retainRatio = 0.16`，与 DSH 默认值一致。
- 摘要提示词原样照抄 `@deepseek-ai/dsh-compaction-basic` 的 `COMPACTION_INSTRUCTION`：
  八个固定小节（Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes /
  Pending Jobs / Current Work / Next Step / Critical Context）。
- 检查点用 `<compacted-summary>...</compacted-summary>` 包裹，前面加 DSH 的 `CHECKPOINT_PREAMBLE`，
  作为会话的 `checkpoint` 字段保存；请求时作为最前面的 user 消息发给模型。
- 触发方式：`src/components/session/ContextBanner.tsx` 在用量 ≥80% 时提示，点「压缩上下文」执行；
  压缩后输入框上方显示「上下文已压缩：更早的对话已折叠为摘要」。
- 上下文窗口：DeepSeek 官方默认 1,000,000；OpenAI 兼容默认 128,000；可在 API 配置里手填覆盖。

### 15.3 版本线

v1.0.0 首发 → v1.0.1 导入走原生下载 + 错误提示带原因 + OpenCode Go/Zen 预设 + 上下文超限提示
→ v1.0.2 更新时直连系统安装器 → v1.0.3 上下文压缩。

---

## 16. 第 6 版：申请官方 API Key 指引

- 新增二级页「申请官方 API Key」（设置 → API Key 管理 → 第一行；无 Key 首次启动直达）。
- 四步说明：注册登录 → 充值 → 创建 Key → 复制粘贴；配三个直达按钮，走 `Browser.open`（Android 上是
  Chrome Custom Tab，视觉上仍在 App 内），分别打开 `platform.deepseek.com/sign_in`、
  `/api_keys`、`/top_up`。
- 「我已拿到 Key，去填写」→ 直接切到 API Key 页并自动展开新增表单，服务商默认 DeepSeek 官方。
- 填完走原来的 `GET /models` 校验，通过才保存。

---

## 17. 第 7 版：压缩前的风险确认

聊天用户和编码用户对「丢历史」的容忍度完全不同，所以压缩不再是一键执行：

- 点「压缩上下文」先弹 `Modal`（`ContextBanner.tsx`），列四条风险：原话/语气/情绪细节消失、
  摘要可能记错人名时间、App 内不可撤销、当日记用只剩梗概。
- 弹窗内提供「先导出备份（ZIP）」：复用 `exportHistory()` + `saveBlob()`，导出完整原文后再压缩。
- 按钮文案改成「我了解风险，仍然压缩」，用 `dangerOutlined` 与普通操作区分。
- 风险文案提到「把这段对话当日记或记录用」，直接点明聊天场景。

---

## 18. 第 8 版：常驻上下文用量条，随时可压缩

1M 窗口下按真实对话很难自然涨到 80%，为了能主动整理/测试，输入框上方常驻一行
「上下文 X% · 压缩上下文」（`ContextBanner` 的 `.meter` 分支），点开走同一套风险确认。
达到 80% 时仍切换成黄色警示条。

自测方法：
1. 直接点这行里的「压缩上下文」→ 风险弹窗 → 「我了解风险，仍然压缩」；
2. 想看警示条：设置 → API Key 管理 → 编辑 DeepSeek → 上下文窗口填 `2000`（或更小）→ 保存，
   聊几句超过 80% 就会变黄；测完把窗口删空恢复默认 1M。

---

## 19. 第 9 版：查看压缩后的摘要

摘要存在 `session.checkpoint.text`，原来界面上只有一行「已压缩」提示，看不到内容。现在：

- 未到阈值时：「上下文已压缩」本身是可点按钮 → 打开 `Modal` 显示摘要；
- 警戒条状态：额外给一个「查看上下文摘要」按钮；
- 弹窗里显示压缩时间、覆盖消息条数，以及去掉 `CHECKPOINT_PREAMBLE` 和 `<compacted-summary>` 标签后的正文
  （八个小节的 Markdown 原文），可滚动。

---

## 20. 第 10 版：压缩不再删除原始消息

之前压缩会把 `session.messages` 替换成「摘要 + 最近几轮」，旧消息直接丢了。改成：

- `Session.compactedThrough` 记录压缩覆盖到的最后一条消息 id；
- `toRequestMessages()` 从该 id 之后开始取历史（`history.slice(start)`），前面用 checkpoint 顶上；
- `applyCompaction()` 只写 checkpoint + compactedThrough，**一条消息都不删**；
- `sessionContextTokens()` 也只统计 checkpoint + 压缩点之后的消息，所以压缩后用量真的会降。

用户侧效果：压缩后往上翻还能看到完整原文（App 本地保存），只是这些内容不再计入上下文。
风险弹窗第 3 条也改成了「原始记录仍完整保存在本机对话里」，不再吓人说「不会留存」。

---

## 21. 第 11 版：已压缩对话的管理页

- `src/services/chat/compactionIndex.ts`：localStorage 里维护一份轻量清单
  `{sessionId, title, createdAt, coveredMessages}`，压缩时写入、恢复时移除。
- 设置 → 数据管理 → 「已压缩的对话」：列出所有压缩过的会话，点开可看摘要原文，
  并提供「打开对话」和「恢复完整上下文」（`clearCompaction()` 清掉 checkpoint / compactedThrough，
  全部原始消息重新参与请求）。
- 数据管理行右侧显示已压缩数量。

---

## 22. 第 12 版：30% 以下禁止压缩

- `compact.ts` 新增 `MIN_COMPACT_RATIO = 0.3` 与 `canCompact()`；`compactSession()` 里也做了二次校验，
  低于 30% 直接返回失败，避免绕过 UI。
- `ContextBanner` 的常驻用量条：≥30% 才渲染「压缩上下文」按钮，低于 30% 显示灰色「（30% 后可压缩）」。
- 目的：少量对话压缩收益很小，反而白白丢细节；等上下文真的用起来再压。

---

## 23. 第 13 版：返回分层 + 左滑抽屉

- **返回键**：`SettingsDialog.tsx` 里统一 `goBack()`：API Key 编辑表单 → API Key 列表 → 设置根页 → 关闭设置；
  并向 `src/shell/native.ts` 注册常驻返回层（`pushLayer` 不再在首次触发后自我移除，否则第二次返回会直接关设置）。
- **手势**：`src/app/edgeSwipe.ts`，在左侧 1/3 屏内向右滑打开抽屉、抽屉内向左滑关闭。
  没有用真正的贴边 24px：Android 14 手势导航会把贴边横滑识别成系统「返回」，实测会直接把 App 退到后台。
