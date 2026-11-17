# Agent 任务 2：设置页（Settings）改原生整页

把下面整段作为 `run_agent` 的 prompt 使用（general-purpose）。

---

You are working in ~/project/chat/chat-demo — a React 18 + rspack + TypeScript static chat client (CSS Modules). We are wrapping it as an Android app (Capacitor WebView) whose mobile UI must look/feel identical to the official DeepSeek Android app v2.8. Desktop (>=768px) stays as-is; scope changes to mobile widths.

Reference material (open images with the read tool):
- ~/project/chat/reference/UI-SPEC.md (§1 tokens, §7 settings, §8 dark mode, §10 checklist)
- ~/project/chat/reference/app-24-settings.png, app-25-appearance.png, app-27-settings-dark.png, app-31-settings-dark2.png (1080x2400 @2.625)
- ~/project/chat/UI-AUDIT.md (settings section)
Official app on emulator: `$HOME/Library/Android/sdk/platform-tools/adb exec-out screencap -p > /tmp/official.png`.

YOUR SCOPE — only these files:
- src/components/settings/SettingsDialog.tsx
- src/components/settings/Settings.module.css (+ .d.ts)
- src/components/settings/ApiKeyField.tsx (only if it must restyle to the row layout)
Do NOT modify anything else (no i18n, no theme.css, no global.css, no other components). New UI strings: literal Chinese, list them in your report.

TARGET (spec §7):
- On mobile the dialog becomes a native FULL-SCREEN page (not a 64px-inset bottom sheet): covers viewport, bg #F8F8F8 (dark #1E1E1E), slide-in from right 220ms.
- Top bar 56px: 40px circular back button (bg #EDEDED / dark #3C3C3D, thin `‹`), 12px left margin; centered title `设置` 18px/600; no right items; no divider.
- Body: grouped cards (#FFFFFF / dark #292929), 16px radius, 16px side margins, rows 46px, 24px icon + 16px gap + 16px label, right value 15-16px #8E9094 and/or `›` #B9BABB; group titles 13px/500 #8E9094 aligned to 16px. Separate cards for `帮助与反馈` and `退出登录`/清除数据.
- Groups map ONLY existing features: 账户(API Key 管理 / 数据管理 = 导入导出历史、清空数据)、应用(语言 / 外观)、语音(仅当已有朗读音色/语速设置)、关于(版本号 / 服务协议 / 开源许可，仅用真实数据)。
- `外观` is a second-level page: single-column rows `跟随系统 / 浅色 / 深色` with a right-aligned blue ✓ (#426EFE) on the active row; back returns to settings root.
- Language row shows current value inline (e.g. `中文 (简体中文)`); tapping opens the existing selector.
- Keep every existing capability reachable; bottom meta text 11px #B9BABB (only real data such as version).
- Dark mode via existing `[data-ds-dark-theme]` selectors.

Hard rules:
- New/changed class names must be added to `Settings.module.css.d.ts` or `pnpm type` breaks.
- Verify: `pnpm build` succeeds; `pnpm type` passes (report pre-existing unrelated errors).
- Visual verification: build, `python3 -m http.server 8099 --directory dist &`, Playwright at ~/project/chat/tools/node_modules/playwright, viewport 412x915 @2.625 isMobile hasTouch; open the settings entry and screenshot to /tmp/settings.png; iterate at least twice vs reference/app-24-settings.png (row pitch 46px, card margins 16px, title sizes, back button).
- Repo style: 2-space, single quotes, semicolons, <=100 cols.

Finish with a report (<=20 lines): files + line refs, spec numbers matched, literal Chinese strings added (for later i18n), anything unmatched.
