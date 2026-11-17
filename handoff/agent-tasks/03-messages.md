# Agent 任务 3：消息区（messages）对齐官方 App

把下面整段作为 `run_agent` 的 prompt 使用（general-purpose）。

---

You are working in ~/project/chat/chat-demo — a React 18 + rspack + TypeScript static chat client (CSS Modules) for the DeepSeek API. We are wrapping it as an Android app (Capacitor WebView) whose mobile UI must look/feel identical to the official DeepSeek Android app v2.8. Desktop (>=768px) stays as-is; scope changes to mobile/touch.

Reference material (open images with the read tool):
- ~/project/chat/reference/UI-SPEC.md (§1 tokens, §5 chat page, §8 dark mode, §10 checklist)
- ~/project/chat/reference/app-23-chat-top.png, app-22-chat.png, app-36-input-typed-dark.png (1080x2400 @2.625)
- ~/project/chat/UI-AUDIT.md (messages section)
Official app on emulator: `$HOME/Library/Android/sdk/platform-tools/adb exec-out screencap -p > /tmp/official.png`.

YOUR SCOPE — only files under src/components/messages/ (MessageList, UserMessage, AssistantMessage, ReplyArea, CopyButton, ReadAloudButton, BranchSwitcher, ReadingBars, MessageFile + their .module.css/.d.ts). Do NOT modify anything else (no i18n, no theme.css, no global.css, no components/session/*, no chatInput).

TARGET (spec §5, px = dp at 411dp viewport):
- User bubble: right-aligned, right gap 16px, max-width 70%, bg #EDF3FE (dark #283142), radius 18px all corners, padding 12px horizontal / 10px vertical, text 16px/1.5 #0F0F0F (dark #F8F8F8). No avatar/timestamp/quote bar.
- Assistant message: NO bubble, full-width text, 22px left + 20px right gutters, 16px/1.6, paragraph gap 12px. Markdown h3 18px/700 with 16px space above; list markers at 24px with hanging indent to 37.7px; hr 1px #E5E5E5 full-bleed; tables 1px #E5E5E5 grid with 8px cell padding (dark #333333).
- Action row under each assistant message: ALWAYS visible on touch/mobile (currently hover-gated `opacity:0` — biggest bug; keep hover reveal on desktop), 20px stroke icons #8E9094, 24px hit areas, 12px gap to text, order 复制 → 赞 → 踩 → 朗读 → 分享, with 重新生成 pushed to the far right (~20px gutter).
- Thinking/深度思考 collapsible, search citations, 继续生成, stop-generation states: app-like (no heavy borders, 13-14px #8E9094 secondary text, #F5F5F5 12px-radius fill cards).
- Scroll-to-bottom button (if present): white 40px circle, subtle shadow, chevron, 20px from right, 16px above input card.
- Long code blocks/tables scroll horizontally inside the 22px gutters without breaking viewport width.
- Dark mode via existing `[data-ds-dark-theme]` selectors.

Hard rules:
- New/changed class names must be added to the sibling `*.module.css.d.ts` or `pnpm type` fails.
- Verify: `pnpm build` succeeds; `pnpm type` passes (report pre-existing unrelated errors).
- The chat screen needs an API key, so you cannot render a real conversation. Verify by static reasoning / a temporary harness in /tmp (never commit it), compare geometry against reference/app-23-chat-top.png, and state explicitly that runtime verification was not possible.
- Repo style: 2-space, single quotes, semicolons, <=100 cols.

Finish with a report (<=20 lines): files + line refs, spec numbers matched, how actions became visible on touch without breaking desktop hover, anything unmatched.
