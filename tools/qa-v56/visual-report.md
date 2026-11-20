# DeepChat 1.0.56 浏览器验收

**通过。** 在 Chrome 138.0.7204.158 中，320×800、390×800、1280×900 三种窗口的浅色和深色均完成设置、账号与模型选择验收。源码产物的主脚本 SHA-256 为 `af8d6fbaae0ba1266edec56405315d5f89996e6cfb2ecbab0ed478106bc65856`。原生 DSH 账号页面的浏览器验证止于正常入口发出 `account` 桥接调用。真实原生页面、登录授权、系统返回及 APK 正式验收留待用户收到公开链接后，在独立 AVD 上完成。

## 覆盖结果

| 范围 | 已验证 |
|---|---|
| 手机设置 | 从会话边栏打开设置，进入语言、朗读音色、版本更新、帮助、用量、字体、位置、WorkBuddy、API 配置、模型上下文、数据、安全和记忆。二级入口继续覆盖申请指南、新增及编辑配置、API 用量、WebDAV、压缩对话和记忆编辑。返回后检查焦点回到原入口。每个手机组合 22 项。 |
| 桌面设置 | 九个页签及其用量、WorkBuddy、清空确认、记忆编辑、更新、帮助入口。关闭子窗口后检查原页签仍选中。每个桌面组合 16 项。 |
| 账号 | 无账号、仅 DSH、仅 WorkBuddy、双账号、切换头像来源、账号更换、退出、重新登录与刷新。校验侧栏与设置中的名称、实际解码后的照片、无照片替代图标。单账号隐藏选择器。双账号的头像选择与 API、DSH、WorkBuddy 对话来源分别切换。每个组合 29 项。 |
| 输入框 | 模型菜单仅有一行选中并带勾选。切换后，入口名称与重新打开时的选中项一致。检查高级入口、菜单边界和动作中心点。中英及 emoji 草稿下能发送，空草稿能录音，闭合工具栏的按钮互不重叠。每个组合 6 项。 |
| 纯浏览器 | 无原生桥接的独立上下文。每个组合从边栏进入 7 个代表界面，保留 42 张 v55 原始基线及 42 张对应源码截图。 |

## 图像复核和修复

- 390 深色双账号页把两个真实昵称与照片置于偏好设置之前。头像来源和聊天通道有各自的标签及控件。v55 的同位置展示通用账号资料及登录入口。[双账号对照图](../../tmp/qa-v56-visual/prelink-archive/390-dark-identities-dual-accounts-comparison.webp)
- 320 浅色 API 编辑页将服务商、地址、密钥归在「连接」中。模型及名称归在「配置」中，上下文窗口可展开。保存按钮可达，输入控件无横向溢出。[配置页对照图](../../tmp/qa-v56-visual/prelink-archive/320-light-routes-api-edit-comparison.webp)
- 390 深色 WorkBuddy「电脑版登录」在首轮源码截图中的文字对比度为 3.37∶1。账号页面负责人调整前景与背景后，浅色实测 5.68∶1，深色 8.25∶1。[WorkBuddy 对照图](../../tmp/qa-v56-visual/prelink-archive/390-dark-routes-workbuddyAccount-comparison.webp)
- 320 宽度首轮出现当前型号两项均显示为 `DeepSee…`，搜索与附件按钮重叠。负责人调整紧凑标签和工具栏后，Flash、Pro 可辨。两种草稿状态下均通过碰撞检测。[输入框对照图](../../tmp/qa-v56-visual/prelink-archive/320-light-model-menu-closed-comparison.webp)
- 桌面数据页的备份行加入边界，自动备份状态与进度保持在同一分组，快照说明仍可见。[桌面数据页对照图](../../tmp/qa-v56-visual/prelink-archive/1280-light-routes-data-comparison.webp)

## 证据和复现

v55 基线来自已经核实的公开 APK 的 `assets/public`。APK SHA-256 为 `7b9d02fd88ae90562b77fa0ae3ecb692b525671899bcc7ab04dd9c886237f9ac`，主脚本 SHA-256 为 `4cb319124c008484c56081be83c39352ed1fdf8b6adb0135c7fd424ce89c9e4a`。首轮基线截图时间为 2026-11-20 16:03（上海）。账号使用隔离的模拟原生端口及合成资料，授权网站和真实网络未纳入浏览器结果。

[本地证据包](../../tmp/qa-v56-visual/prelink-archive/browser-evidence.zip) 存有八份运行清单，含浏览器版本、资产指纹、各用例检查和截图索引。240 次截图去重为 196 张无损 WebP，共 3,601,572 字节。归档 SHA-256 为 `c87b13eb99a3a068c587d772281d23e2301ea4209401b5f2dccebecc97673b32`。逐张重建像素后，尺寸及 RGB 哈希全部一致。

从仓库根目录运行，给每个命令指定新的输出目录。`ASSETS` 是含 `index.html` 的已构建资源目录。浏览器通过本地请求拦截加载这些资源。`CHROME_EXECUTABLE_PATH` 可指定现有 Chrome 路径。

```sh
node tools/qa-v56/settings.mjs "$ASSETS" "$OUT/routes"
node tools/qa-v56/identity.mjs "$ASSETS" "$OUT/identity"
node tools/qa-v56/model-menu.mjs "$ASSETS" "$OUT/model"
node tools/qa-v56/pictures.mjs "$ASSETS" "$OUT/plain"
```

独立运行正常后可用 Python 与 Pillow 指定 8 个对应的结果目录，生成无损压缩包和 5 张同尺寸对照图。新输出目录可防止覆盖另一轮验收。

```sh
python3 tools/qa-v56/archive.py "$ARCHIVE" \
  v55-routes="$V55/routes" v56-routes="$V56/routes" \
  v55-identity="$V55/identity" v56-identity="$V56/identity" \
  v55-model="$V55/model" v56-model="$V56/model" \
  v55-plain="$V55/plain" v56-plain="$V56/plain"
```
