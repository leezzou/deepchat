# Agent 任务 1：抽屉（Sider）对齐官方 App

把下面整段作为 `run_agent` 的 prompt 使用（general-purpose）。任务文件范围与另两个 agent 严格互斥。

---

You are working in ~/project/chat/chat-demo — a React 18 + rspack + TypeScript static chat client (CSS Modules). We are wrapping it as an Android app (Capacitor WebView) whose mobile UI must look/feel identical to the official DeepSeek Android app v2.8. Desktop layout (>=768px) must stay as-is; scope all changes to mobile/touch behavior.

Reference material (open images with the read tool — it supports PNG):
- ~/project/chat/reference/UI-SPEC.md (measured spec; read §1 tokens and §6 drawer, §10 checklist)
- ~/project/chat/reference/app-21-drawer.png, app-30-drawer-dark.png, app-35-drawer-search.png, app-33-drawer-search-dark.png (real screenshots, 1080x2400 @ 2.625 dpr)
- ~/project/chat/UI-AUDIT.md (current-code audit)
The official app is installed and running on the emulator: `$HOME/Library/Android/sdk/platform-tools/adb exec-out screencap -p > /tmp/official.png`, `adb shell uiautomator dump` for bounds.

YOUR SCOPE — only these files:
- src/components/sider/Sider.tsx, Sider.module.css (+ .d.ts)
- src/components/sider/SessionItem.tsx (+ .module.css/.d.ts)
- src/components/sider/CollapsedSider.tsx (mobile only if relevant)
- src/components/sider/mobileSiderState.ts
Do NOT modify anything else (no i18n, no theme.css, no global.css, no index.html, no other components).

TARGET (spec §6, 1080px screenshots ÷2.625 = CSS px):
- Panel width 310px (=75% of 411dp), slides in from left, right edge radius 16px, bg #FFFFFF / dark #0F0F0F, 250ms ease. Full height. Underlying content covered by an almost opaque scrim (rgba(0,0,0,0.2) over a #F5F5F5-ish surface); tapping scrim closes; Esc closes.
- Top: search pill, 16px side margins, height 48px, radius 999px, bg #F5F5F5 (dark #292929), 20px magnifier (#8E9094) + 15px placeholder #8E9094 `搜索对话内容...`. No panel title, no collapse icon, no `API 使用 demo` header, no close button.
- Date group headers: 13px/500, #8E9094, left padding 21px, row height 46px.
- Session rows: single line 16px, #0F0F0F (dark #F8F8F8), left padding 21px, right 21px, height 46px, no dividers/icons/timestamps, ellipsis; keep the existing per-item `⋯` menu without reserving visible space; active row = subtle #F5F5F5 fill (no border).
- Footer pinned bottom: 40px round avatar (initials / neutral line-art, bg #F5F5F5) + username 16px, right `⋯` 20px (44px hit area) opening the existing settings dialog; 24px gradient fade (#FFFFFF→transparent) above the footer. Nothing else.
- No "new chat" entry in the drawer.
- Dark mode via the existing `[data-ds-dark-theme]` selectors.

Hard rules:
- New/changed class names must be added to the sibling `*.module.css.d.ts` or `pnpm type` breaks.
- Verify: `pnpm build` succeeds; `pnpm type` passes (report pre-existing unrelated errors instead of fixing out-of-scope files).
- Visual verification: after build run `python3 -m http.server 8099 --directory dist` in background, then screenshot with Playwright at ~/project/chat/tools/node_modules/playwright:
  node -e "const {chromium}=require('~/project/chat/tools/node_modules/playwright');(async()=>{const b=await chromium.launch();const c=await b.newContext({viewport:{width:412,height:915},deviceScaleFactor:2.625,isMobile:true,hasTouch:true});const p=await c.newPage();await p.goto('http://localhost:8099');await p.waitForTimeout(1200);await p.mouse.click(30,60);await p.waitForTimeout(600);await p.screenshot({path:'/tmp/drawer.png'});await b.close()})()"
  Iterate at least twice vs reference/app-21-drawer.png (panel width, search pill, row heights, footer). Screenshots to /tmp only.
- Repo style: 2-space, single quotes, semicolons, <=100 cols. Keep Sider's public props/behavior so call sites don't break.

Finish with a report (<=20 lines): files changed with line refs, spec numbers matched, desktop preserved?, anything unmatched and why.
