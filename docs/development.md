# 开发与构建

[← 返回首页](../README.md)

DeepChat 的 Web 页面位于 `chat-demo/`，Android 外壳由 Capacitor 6 提供。下列命令从仓库根目录执行，适用于 macOS、Linux 或 WSL 的 POSIX shell。

## 环境

| 工具 | 要求 |
| --- | --- |
| Node.js | 建议 22.12 或更新版本；构建工具声明的范围为 `^20.19.0 \|\| >=22.12.0`。 |
| pnpm | 9 或 10，支持仓库中的 lockfile v9。 |
| Java | JDK 17，通过 `JAVA_HOME` 指向该版本。 |
| Android SDK | Platform 34 及配套构建工具；通过 `ANDROID_HOME` 或本地 SDK 配置提供路径。 |
| Gradle | 使用仓库 Wrapper，当前为 8.2.1，AGP 为 8.2.1。 |

Android 工程声明 `minSdk=22`、`targetSdk=34`、`compileSdk=34`。最低安装版本为 Android 5.1，但旧设备的 WebView 兼容性需要单独验证。Web 构建目标为 Chrome / Edge 105+、Safari 16+、Firefox 110+。

## Web 开发

```bash
pnpm --dir chat-demo install --frozen-lockfile
pnpm --dir chat-demo dev
```

默认访问 `http://localhost:8090`。浏览器直接连接所配置的 API，服务端需要允许相应的跨域请求；不要把 Web 环境的 CORS 行为推断为 Android 原生文件下载的行为。

```bash
pnpm --dir chat-demo type
pnpm --dir chat-demo lint
pnpm --dir chat-demo build
```

构建结果位于 `chat-demo/dist/`；运行时根据当前脚本地址推导资源加载路径。

## Android Debug

确认 JDK 和 Android SDK 配置完毕后执行：

```bash
pnpm --dir chat-demo build
pnpm --dir chat-demo exec cap sync android
./chat-demo/android/gradlew -p chat-demo/android assembleDebug

adb install -r chat-demo/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.deepseek.demo.shell/.MainActivity
```

Web 源码有变化时，需要重新构建并执行 `cap sync android`，随后重新打包安装。仅修改 Web 源码不会改变已安装的 APK。

应用 ID 为 `ai.deepseek.demo.shell`。不同签名的安装包不能直接互相覆盖；卸载应用会清理本地数据，操作前应先导出需要保留的聊天。

## Release 签名

生产发布需要自己的 Android 签名密钥。当前工程从被 Git 忽略的 `chat-demo/android/keystore.properties` 读取以下字段：

```properties
storeFile=/absolute/path/to/release.keystore
storePassword=your-store-password
keyAlias=your-key-alias
keyPassword=your-key-password
```

请在本地配置真实值，保持密钥和口令不入库。没有这个配置时，`assembleRelease` 不会自动回退到 Debug 签名，不应把输出当作已签名的安装包。

```bash
pnpm --dir chat-demo build
pnpm --dir chat-demo exec cap sync android
./chat-demo/android/gradlew -p chat-demo/android assembleRelease
```

使用正式签名配置时，输出通常为 `chat-demo/android/app/build/outputs/apk/release/app-release.apk`。正式更新应保持相同应用 ID、相同签名，并递增版本。

维护者可使用 [发布脚本](../scripts/release.sh)，但该脚本会修改版本和更新清单、提交并推送仓库、创建 GitHub Release；请在需要正式发布时使用。应用读取仓库根目录的 [更新清单](../update.json)，失败时回退到 GitHub Releases API。

## 代码入口

| 目录或文件 | 用途 |
| --- | --- |
| [app](../chat-demo/src/app/) | 应用入口、主题、移动视口及手势。 |
| [components](../chat-demo/src/components/) | 会话、输入框、设置、Markdown 展示等 UI。 |
| [services/api](../chat-demo/src/services/api/) | API 请求、流式响应、附件及语音接口。 |
| [services/chat](../chat-demo/src/services/chat/) | 会话状态、IndexedDB、上下文压缩和备份。 |
| [i18n](../chat-demo/src/i18n/) | 简体中文、英文文案及语言选择。 |
| [shell](../chat-demo/src/shell/) | Android 返回键、分享、文件保存与 APK 安装。 |
| [android](../chat-demo/android/) | Capacitor Android 工程。 |
| [配图说明](artwork.md) | 主视觉、音色头像和展示图来源。 |

## 验证建议

提交界面变更前，至少运行类型检查和生产构建。涉及 Android 的改动应在安装后的应用上检查返回键、键盘、触控和深浅主题；涉及 API 的改动应使用相应服务商真实支持的接口验证，不应以预设存在或 `GET /models` 成功代替完整聊天验证。
