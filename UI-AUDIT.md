# UI Audit — chat-demo web app → DeepSeek-style Android app (Capacitor WebView)

Scope: `~/project/chat/chat-demo`, read-only static audit of the mobile layout (`< 768px`).
Reference target: `com.deepseek.chat` (official Android app): home screen, drawer, chat screen, input card, message actions, settings.
Method: full read of every referenced TSX/CSS/TS file, all `@media` blocks grepped, token values read from `src/app/theme.css`. No files under `chat-demo/src` were modified.
Mobile breakpoint in this codebase is **one** query, repeated ~20 times: `@media not all and (min-width: 768px)`. Two extra sub-breakpoints exist: `440px` (bubble/greeting/textarea) and `1023px` (message column width). Runtime mirror: `src/app/viewport.ts:4` (`matchMedia('not all and (min-width: 768px)')`).

---

## 0. Executive summary

The mobile layer is a *desktop app that reflows*: 60px header, absolute-positioned frame, drawer without scrim/animation, hover-gated action rows, a 760×500 settings dialog turned into a bottom sheet, and three `env(safe-area-inset-bottom)` calls that resolve to **0** because the viewport meta has no `viewport-fit=cover`. Nothing is broken in a browser; in a Capacitor WebView it will look "web inside a phone" rather than native.

| Area | State | Native-app gap |
|---|---|---|
| Tokens | Coherent `--dsw-*` alias/static two-layer palette, but **zero radius/spacing/safe-area tokens** | Radii hardcoded 12/16/18/22/24/100px per component |
| Home | Greeting vertically centered by `margin: auto 0`, input pinned bottom, no logo, no suggestion chips | Official: logo + greeting in upper third, 4 suggestion chips, input card at bottom |
| Drawer | 300px panel, **transparent** mask, **no animation**, header = "API 使用 demo" + collapse icon | Official: full-height panel + dim + slide, no collapse icon |
| Chat | 60px header, user bubble 22px radius, action row hidden unless last message | Official: 56px header w/ safe area, actions always visible |
| Settings | 760×500 dialog → bottom sheet w/ `height: calc(100% - 64px)`, horizontal tabs, chevrons hidden | Official: full-screen routed page, grouped rows, back arrow |
| WebView | No `viewport-fit`, no link interception, blob-URL ZIP export, hover-only UI, `ScriptProcessorNode` mic | 8 concrete breakages, see §6 |

---

## 1. Design tokens

### 1.1 Type & global scale — `src/app/theme.css:1-26`

```css
/* 1-6 */ :root { --dsw-font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
          Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
          font-variant-ligatures: no-contextual; }
/* 9-13  */ --ds-control-height-xl: 44px; -l: 40px; -m: 36px; -s: 32px; -xs: 28px;
/* 15    */ --ds-font-size-m: 14px;                 /* the only base font size token */
/* 17    */ --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
/* 19-22 */ --ds-font-family-code: Menlo, Monaco, Consolas, 'Cascadia Mono', …;
/* 24-25 */ --ds-transition-duration: 0.2s; --ds-transition-duration-slow: 0.3s;
```

- **No mobile typography override exists.** A 14px base with 16px inputs is fine on Android, but `--ds-font-size-m` never changes at `<768px`.
- There is **no** `--ds-font-size-*` ramp (only `m`), so every other size is a literal (`16px`, `13px`, `12px`, `11px`) inside component CSS.

### 1.2 Static palette — `theme.css:28-116`

Duplicated verbatim for light (`body`, 28-71) and dark (`body[data-ds-dark-theme]`, 73-116); the **only** difference is `--dsw-static-neutral-bluish-60` (`rgb(245,246,247)` vs `rgb(249,250,251)`).

| Ramp | Values |
|---|---|
| neutral-bluish | 00 `#fff`, 50 `rgb(249,250,251)`, 60, 75 `rgb(241,243,245)`, 100 `rgb(235,238,242)`, 150, 200 `rgb(225,229,238)`, 300 `rgb(207,211,214)`, 400 `rgb(173,178,184)`, 600 `rgb(129,133,140)`, 700 `rgb(97,102,107)`, 750 `rgb(67,69,74)`, 800 `rgb(53,54,56)`, 850 `rgb(44,44,46)`, 900 `rgb(27,27,28)`, 950 `rgb(21,21,23)`, 1000 `rgb(15,17,21)` |
| blue | 50 `rgb(237,243,254)`, 100 `rgb(228,237,253)`, 200 `rgb(211,226,255)`, 300 `rgb(183,200,254)`, 400 `rgb(103,158,254)`, 450 `rgb(86,134,254)`, 500 `rgb(57,100,254)`, 600 `rgb(72,104,178)`, 800 `rgb(52,65,91)`, 900 `rgb(40,49,66)` |
| red | 400 `rgb(242,90,90)`, 600 `rgb(236,19,19)` |
| amber / green / neutral | full ramps at `theme.css:29-33,44-47,66-70` |

### 1.3 Alias tokens (the actual theme surface)

| Token | Light (`theme.css:118-167`) | Dark (`169-218`) |
|---|---|---|
| `--dsw-alias-bg-base` | bluish-00 `#fff` | bluish-950 `rgb(21,21,23)` |
| `--dsw-alias-bg-layer-2` / `-3` | bluish-00 / bluish-00 | bluish-850 / bluish-800 |
| `--dsw-alias-bg-skeleton` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.08)` |
| `--dsw-alias-border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` |
| `--dsw-alias-border-l2` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.12)` |
| `--dsw-alias-border-l2-darkmode-thin` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.06)` |
| `--dsw-alias-brand-primary` | blue-500 | blue-450 |
| `--dsw-alias-brand-text` | blue-500 | blue-400 |
| `--dsw-alias-button-primary-fill` / `-hover` | brand-primary / blue-450 | brand-primary / blue-500 |
| `--dsw-alias-button-contrast-fill` | bluish-700 | bluish-50 |
| `--dsw-alias-button-elevated-fill` | bluish-00 | bluish-750 |
| `--dsw-alias-button-ghost-active-fill/-border/-hover` | blue-50 / blue-300 / blue-100 | blue-900 / blue-600 / blue-800 |
| `--dsw-alias-label-primary` | bluish-1000 | bluish-50 |
| `--dsw-alias-label-secondary` | bluish-700 | bluish-300 |
| `--dsw-alias-label-tertiary` | bluish-600 | bluish-400 |
| `--dsw-alias-label-caption` | bluish-400 | bluish-600 |
| `--dsw-alias-label-dimmed` | bluish-200 | bluish-750 |
| `--dsw-alias-label-primary-foreground` / `-inverted` | bluish-00 | bluish-00 / bluish-800 |
| `--dsw-alias-interactive-bg-hover` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` |
| `--dsw-alias-state-error-primary` | red-600 | red-400 |
| `--dsw-specific-input-major` | bluish-00 | bluish-850 |
| **`--dsw-specific-bubble`** | **blue-50** | **bluish-850** |
| `--dsw-specific-login-input` | bluish-50 | bluish-900 |
| `--dsw-specific-sidebar-fill` | bluish-50 | bluish-900 |
| `--dsw-specific-sidebar-nav-item-hover` | bluish-75 | bluish-850 |
| `--dsw-alias-markdown-code-block` / `inline-code` / `citation` / `tag` | bluish-50 / 100 / 100 / 75 | bluish-900 / 850 / 800 / 850 |
| `--dsw-alias-toast-bg` | bluish-800 | bluish-750 |
| `--dsw-alias-tooltip-bg` | bluish-850 | bluish-750 |

`--dsw-shadow-lv3` (`theme.css:221-223`): `0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)` — single shadow, no mobile variant.

### 1.4 Fonts, markdown typography — `theme.css:225-253`

h1 `700 24/34`, h2 `700 22/32`, h3 `700 20/30`, h4 `600 16/28`, base `16/28`, base-strong `600 16/28`, table `15/25`, small `14/24`, small-strong `600 14/24`, code `14/22` (`--ds-font-family-code`), code-block `13/22`, `--dsw-font-s-strong-14: 500 14/22`, `--dsw-font-xs-13: 13/20`.
Comment text is 11px (`Welcome.module.css:62`, `SessionView.module.css:55`) — below Android's 12sp minimum for legible body copy.

### 1.5 Radii — **no tokens**, all literals

| Radius | Where |
|---|---|
| 22px | user bubble `UserMessage.module.css:34`, edit box `:77` |
| 24px | input card `ChatInput.module.css:11`; modal `Modal.module.css:24` |
| 24px 24px 0 0 | settings sheet `Settings.module.css:298` |
| 18px | think/search toggle pill `ChatInput.module.css:266` |
| 16px | drawer session item (mobile) `SessionItem.module.css:72`, attachment thumb `ChatInput.module.css:49`, settings apiKey inputs `Settings.module.css` mobile block |
| 12px | drawer item desktop `SessionItem.module.css:8`, settings nav item, SearchPanel row `SearchPanel.module.css:49` |
| 100px | "开启新对话" pill `Sider.module.css:47`, collapsed group `:189`, search summary pill `AssistantMessage.module.css:117` |
| 4096px | `Button.module.css:7` |
| 50% | send button `ChatInput.module.css:318`, voice button `VoiceButton.module.css:31` |

### 1.6 Safe area — **3 uses only, all bottom**

| File:line | Value |
|---|---|
| `src/components/session/Welcome.module.css:50` | `padding: 0 16px env(safe-area-inset-bottom)` |
| `src/components/session/SessionView.module.css:68` | `padding-bottom: env(safe-area-inset-bottom)` |
| `src/components/settings/Settings.module.css:333` | `padding-bottom: env(safe-area-inset-bottom)` |

No `env(safe-area-inset-top)` / `-left` / `-right` **anywhere**. `src/index.html:5` has `content="width=device-width,initial-scale=1"` — **without `viewport-fit=cover` these three declarations are computed as `0px`**, so they are dead code today.

### 1.7 Root sizing — `src/app/global.css:1-54`

- `:root` `--message-list-max-width: 840px`, `--message-list-padding-horizontal: 44px`; at `≤1023px` → `712px` / `36px` (6-11). Note: mobile column does **not** use the horizontal token (see §4.4).
- `body` (`13-29`): `overflow:hidden`, `font-size: var(--ds-font-size-m)` = 14px, `-webkit-text-size-adjust:none`, **`-webkit-tap-highlight-color: transparent`** (good), `-webkit-font-smoothing:antialiased`.
- Mobile (`46-53`): `html, body, #root { height:100%; overflow:hidden; overscroll-behavior-y:none }`.
- App shell (`src/app/App.module.css:55-61`): mobile `.frame { position: fixed; top: var(--app-viewport-top, 0px); height: var(--app-viewport-height, 100dvh) }`.

---

## 2. Mobile home screen

Composition: `src/components/session/Welcome.tsx:12-19`

```
.container (Welcome.module.css:1-5)   position:absolute; inset:0; display:flex
 ├ MobileHeader                       (mobile only, Welcome.tsx:13)
 └ .welcome (7-17)
     ├ .greeting  "今天有什么可以帮到你？"   (Welcome.tsx:15)
     ├ <ChatInput sessionId={null} />      (16)
     └ .caveat    "内容由 AI 生成，请仔细甄别" (mobile only, 17)
```

### 2.1 Exact geometry at `<768px` (`Welcome.module.css:39-67`)

| Element | Value |
|---|---|
| `.container` | `flex-direction: column`, `inset: 0` |
| `.welcome` | `flex:1; min-height:0; justify-content:flex-end; max-width:none; margin:0; padding:0 16px env(safe-area-inset-bottom)` |
| `.greeting` | **`margin: auto 0`** → vertically centered in the leftover space between header and input; `flex-shrink:0`; 24/32 600 (desktop), 20/28 500 at `<440px` (`31-37`); `margin-bottom:21px` from the base rule (`19-29`) |
| `.caveat` | `padding:6px 0; font-size:11px; line-height:16px; tertiary; user-select:none; text-align:center` |

Measured result on a 390×844 viewport: header 60 + input card ≈104 (textarea `1.25 × 24 + 12 = 42` from `ChatInput.module.css:209-214`, plus function row `4 + 12 + 34 + 12 = 62`) + caveat 28 → greeting centre lands at **≈46% of screen height**, i.e. mid-screen. Side gutters for the card: `16px` (from `.welcome` padding), card width = `100% - 32px`.

Logo: **none** — no brand asset is imported anywhere in `src/` (only `NewChatIcon` inside the drawer pill, `Sider.tsx:72-74`). No suggestion chips, no "history" or "recent chats" block, no scroll container on this screen (`overflow` comes only from `body`).

### 2.2 `MobileHeader` — `MobileHeader.tsx:9-33`, `MobileHeader.module.css:1-19`

| Part | Value |
|---|---|
| `.header` | `height:60px; padding:12px 10px 4px; align-items:center; flex-shrink:0` |
| Left | `IconButton size="xl"` = **44×44** menu (`MobileHeader.tsx:13-19` → `IconButton.module.css` `.xl`) |
| Middle (session only) | `.title` `flex:1; margin:0 12px; 500 14/22; ellipsis` (`MobileHeader.module.css:10-19`) |
| Right (session only) | 44×44 "new chat" (`MobileHeader.tsx:23-29`) |
| Home | title/new-chat omitted → **menu button alone, header still 60px tall** with nothing to the right |

No `env(safe-area-inset-top)` → in edge-to-edge (Android 15 default) the 44px button sits under the status bar; the 60px height leaves only `60 − 4 = 56px` of usable row below the inset.

### 2.3 `ChatInput` card — `ChatInput.module.css:1-332`, `ChatInput.tsx:160-289`

| Part | Value (`:line`) |
|---|---|
| `.wrapper` | `border-radius:24px; border:1px solid var(--dsw-alias-border-l2-darkmode-thin); background:var(--dsw-specific-input-major); font-size:16px; line-height:24px; overflow:hidden` (`1-15`) |
| `.home` shadow | `0 4px 12px rgba(0,0,0,.02), 0 2px 2px rgba(72,104,178,.01), 0 30px 60px rgba(72,104,178,.03)`; **dark: `none`** (`23-32`) |
| `.session` shadow | `0 4px 10px rgba(0,0,0,.02), 0 2px 4px rgba(0,0,0,.04)` (`17-21`) |
| textarea | `padding:12px 12px 0 16px`, transparent, `min-height: 2*24 + 12 = 60px`, mobile `<440px`: `1.25*24+12 = 42px` (`171-214`) |
| `.mirror` max-height | `336px` (`219`) |
| mobile wrapper cap | `max-height: calc(var(--app-viewport-height,100dvh) - 120px)` (`222-226`) |
| `.functionRow` | `display:flex; align-items:center; gap:8px; margin-top:4px; padding:12px` (`238-244`) |
| `.toggles` | `flex:1; gap:10px; min-width:0` (`246-252`) |
| `.toggle` | `height:34px; padding:0 12px; border-radius:18px; border:1px solid var(--dsw-alias-border-l2); background:transparent; 500 13/20` (`258-298`); selected → `ghost-active-fill` (blue-50 / blue-900) + `brand-text` + `ghost-active-border` |
| `.right` | `gap:4px; margin-left:auto` (`300-306`) |
| `.sendButton` | `34×34`, `border-radius:50%`, `background: var(--dsw-alias-button-primary-fill)`, icon `--dsw-static-neutral-bluish-00`, `margin-left:6px`; disabled `opacity:.4` (`308-332`) |

**Bottom function-row order** (`ChatInput.tsx:202-287`): `深度思考` pill → `智能搜索` pill → (flex spacer) → `VoiceButton` (34×34, icon only, timer hidden at `<768px` — `VoiceButton.module.css:12-16`) → attach `IconButton size="m"` (34×34 paperclip) → send/stop `34×34` circle.

Conditional pieces: `Spectrum` overlays the first text line while recording (`ChatInput.tsx:197`, `Spectrum.module.css:5-18`: `position:absolute; left:16px; right:12px; height:36px; opacity:.7`, 2×5px bars); `DraftAttachments` renders a horizontally scrolling strip `padding:12px 12px 0; gap:10px`, 64×64 thumbs radius 16 (`ChatInput.module.css:34-64`, `DraftAttachments.tsx:26-38`); `DragMask` on desktop drag only.

### 2.4 Δ vs official app — home

| # | Delta | Current | Target |
|---|---|---|---|
| H1 | **Logo missing** | nothing | 56×56 whale mark centred, 24px above greeting |
| H2 | **Greeting position** | `margin: auto 0` → screen centre (≈46%) | greeting block anchored at ~22–26% (`padding-top: 18vh`), logo above it, 20/28 500 on all mobile widths |
| H3 | **Suggestion chips missing** | none | 2×2 grid, 44px rows, `border-radius:16px`, `background: var(--dsw-specific-sidebar-fill)`, `border:1px solid var(--dsw-alias-border-l2)`, `14/22`, `padding:0 14px`, gap 10 — new component `SuggestionChips.tsx` mounted in `Welcome.tsx:14` between greeting and input |
| H4 | **Toggle placement** | pills sit *inside* the bordered card bottom row, transparent w/ 1px outline | official: same row but pills are filled chips (`background: var(--dsw-alias-bg-skeleton)` when off, `ghost-active-fill` when on, **no border**), 32px height, 16px radius |
| H5 | **Send button style** | 34px filled brand circle + outline paper-plane | official: 32px circle, arrow-up glyph, `background: var(--dsw-alias-button-primary-fill)` but **`opacity`-only disabled state and no hover**; move attach/voice *inside* a left cluster so send is flush right at 12px |
| H6 | **Caveat** | 11px line below card, inside `.welcome` | official: 11px tertiary, `padding-bottom: 8px + safe-area`, sits *outside* the scroll area, 12px from card |
| H7 | **No scroll** | screen is static | official: chip area scrolls under keyboard, greeting sticky-collapses |
| H8 | **Input radius/shadow** | 24px + triple shadow | official: 26px radius, single soft shadow `0 2px 12px rgba(0,0,0,.06)`, no shadow in dark (already `none`) |

---

## 3. Drawer / session list

`src/components/sider/Sider.tsx:149-160` (`MobileSider`) → `mobileSiderState.ts` (zustand `{open}`, `openMobileSider/closeMobileSider`; auto-closed on session change in `App.tsx:68`).

### 3.1 Structure & CSS

| Part | Value |
|---|---|
| `.drawerMask` | `position:absolute; inset:0; z-index:799` — **no background colour, no blur, no `onClick` affordance visible** (`Sider.module.css:203-207`); tap-to-close wired at `Sider.tsx:151` |
| `.drawer` | `position:absolute; top:0; bottom:0; left:0; z-index:800` (`195-201`); **no transform / no transition** → panel appears instantly |
| `.sider` base | `width:261px; padding:6px 12px 0; border-right:1px solid var(--dsw-alias-border-l1); background:var(--dsw-specific-sidebar-fill)` (`1-11`) |
| `.mobile` override | `width:300px; max-width:calc(100vw - 48px)` (`209-211`) |
| Header `.top` | `height:48px; margin-bottom:16px; padding:15px 0 10px 4px` (`13-23`) |
| `.appName` | `20px/22px 600`, `color: var(--dsw-alias-brand-primary)` (`25-35`) — text is `t('appName')` = **"API 使用 demo"** (`Sider.tsx:55`) |
| Header right | `IconButton size="m"` (34px) `IconPanelLeftOutline16` tooltip `收起边栏`; **on mobile it closes the drawer** (`Sider.tsx:56-62`) |
| New chat | full-width `height:40px; border-radius:100px; background: var(--dsw-alias-button-elevated-fill)`, 3-layer shadow, dark: inset highlight (`37-75`); label `t('newChat')` = "开启新对话" |
| `.listWrap` | `margin-top:24px`, mobile `16px` (`86`, `213-215`) |
| `.sectionHeader` | sticky `top:0; z-index:20; 12/18 500 tertiary; padding:2px 10px`, mobile `14/22`, `padding:4px 10px 3px` (`107-118`, `217-221`) |
| `.section` | `margin-top:16px; padding-top:4px` (`97-105`) |
| `.bottom` | `height:64px`, mobile `height:auto; padding:12px 0` (`120-124`, `223-226`) |
| Settings row | `padding:6px 2px 6px 6px; border-radius:12px`, icon 32px + label 14px; mobile `padding:9px 10px`, icon 20px, label `16/22; margin-left:10px` (`126-169`, `228-246`) |

Grouping — `src/services/chat/sessionGroups.ts:10-32`: `今天` / `昨天` / `7 天内` / `30 天内`, then month key (`monthKey()`); consecutive sessions only, order comes from the store.

Item — `SessionItem.module.css`: desktop `height:40px; padding:9px 6px 9px 10px; radius 12px; 14/22` (6-9); mobile `height:44px; padding:11px 6px 11px 12px; radius 16px; font-size:16px` (68-74); rename input `44px / radius 16 / 16px` (80-85). Row menu button appears on `@media (hover:none)` (`62-66`).

**Bottom section**: exactly one row — `设置` (`Sider.tsx:94-100`). No account/avatar, no "我的", no version, no privacy links.

### 3.2 Δ vs official app — drawer

| # | Delta | Fix location |
|---|---|---|
| D1 | **No scrim** → content behind drawer is fully visible and undistinguished | `Sider.module.css:203-207` add `background: rgba(0,0,0,.32)` + `backdrop-filter` optional; animate opacity |
| D2 | **No open/close animation** | `Sider.module.css:195-201` add `transform: translateX(-100%)` + `transition: transform .25s cubic-bezier(.4,0,.2,1)`; mount-state class from `mobileSiderState.ts` |
| D3 | Header shows **product codename** "API 使用 demo" (brand-coloured 20px) and a *collapse* icon | replace with app name `DeepSeek`-style wordmark + no icon; move a close affordance into the row or rely on scrim |
| D4 | Width **300px** on a 390px screen (77%), max `100vw − 48px` | official ≈ **88vw** (`width: min(88vw, 360px)`) |
| D5 | **No top/bottom safe area**: `padding: 6px 12px 0` | `padding-top: calc(6px + env(safe-area-inset-top))`, `.bottom { padding-bottom: calc(12px + env(safe-area-inset-bottom)) }` |
| D6 | Section labels 14/22 tertiary — official uses 12/18 with 8px extra top gap and no sticky background seam | `.sectionHeader` mobile → `12/18`, `background: transparent` |
| D7 | **No footer account block** (avatar, email/plan, 我的) | new `.account` row above `.settings`, 56px, `border-top:1px solid var(--dsw-alias-border-l1)` |
| D8 | Item 44px/no leading icon — official rows are 48px with 20px glyph | `SessionItem.module.css:68-74` → `height:48px` |

---

## 4. Session view: header + messages

### 4.1 Header

`SessionView.tsx:25-33` → mobile renders `<MobileHeader title={title} />`; desktop renders `.header` (`SessionView.module.css:8-16`, 60px, `padding:12px 18px 0`) + `.title` (`18-26`, `max-width:480px; padding:8px 12px; 500 14/22`) and `.withCollapsedSider { margin-left:113px }` (`28-30`, desktop-only path).

Mobile header = §2.2: 60px, `padding:12px 10px 4px`, 44px menu, centred 14/22 500 truncated title, 44px new-chat. Header background `--dsw-alias-bg-base`, **no hairline border** (official has none either, but it does scroll-collapse).

### 4.2 Message list plumbing

- `MessageList.module.css:1-13`: desktop single scroller `.container` with `scrollbar-gutter: stable both-edges`.
- Mobile (`15-30`): `.container { overflow:hidden }`, inner `.scroll { display:flex; flex:1; overflow-y:auto; overscroll-behavior-y: contain }` — **two nested scroll contexts** that swap at 768px.
- Column (`32-36`): `width: calc(840px − 88px)`, `max-width: calc(100% − 40px)` → **mobile gutters are 20px**, `padding-bottom:24px`. `--message-list-padding-horizontal` is *not* used on mobile.
- Scroll behaviour `MessageList.tsx:63-100`: `ResizeObserver` on content+scroller keeps `scrollTop = scrollHeight` while `stickyRef` is true; version switch anchors by `getBoundingClientRect().top` (`104-115`); breakpoint change migrates `scrollTop` (`118+`).

### 4.3 User message — `UserMessage.module.css`

| Part | Value |
|---|---|
| `.container` | column, `align-items:flex-end`, `padding-bottom:16px`; first message `padding-top:34px` (`1-9`) |
| hover reveal | `&:hover .actions { opacity:1 }` (`11-13`) |
| `.files` | wrap, right-aligned, gap 10, `margin-bottom:8px` (`16-24`) |
| `.bubble` | **`max-width: calc(100% − 88px)`**, `padding:10px 16px`, `border-radius:22px`, `16/24`, `background: var(--dsw-specific-bubble)` (blue-50 / bluish-850), `white-space:pre-wrap` (`30-41`); `<440px` → `calc(100% − 68px)` (`43-47`) |
| `.bottom` | `height:28px; margin-top:6px; gap:10px` (`49-55`) |
| `.actions` | `opacity: 0` → `1` only via `.alwaysShow` when `isLast` (`57-71`; `UserMessage.tsx:117`) |
| Action order (`UserMessage.tsx:116-130`) | `复制` (CopyButton) → `编辑消息` (IconButton 16) → **`BranchSwitcher` after the actions** |
| Edit mode | `.editor` radius 22 brand border; textarea `min-height:44px; max-height:202px; padding:10px 16px; 16/24`; buttons `取消`/`发送` right-aligned (`73-104`) |

### 4.4 Assistant message — `AssistantMessage.module.css` / `AssistantMessage.tsx`

- No bubble: markdown block at full column width, `--dsw-font-markdown-base` = **16/28**, colour `--dsw-alias-label-primary`; `.message :global(.ds-assistant-message-main-content) { padding-bottom:6px }` (`9-11`).
- Waiting state: three 6px dots, `.waiting { height:34px; gap:6px }` (`14-47`).
- `.notice` (error/refusal): `margin-top:8px; 14/22; color: var(--dsw-alias-state-error-primary)` + action link `更换 API Key` / `前往充值` (`49-82`, `AssistantMessage.tsx:100-126`).
- Search summary pill: `border-radius:100px; border:1px solid var(--dsw-alias-border-l2); padding:4px 10px 4px 4px; margin-top:16px`, thumbnails + `{count} 个网页` (`111-138`, TSX `127-140`).
- `.bottom` action row: **`position:relative; left:-6px; padding:12px 0 10px; gap:10px; flex-wrap:wrap`** (`84-93`).
- **Action order (TSX `141-175`)**: `BranchSwitcher` → `actions[`复制` → `朗读` → `重新生成`]` → `继续生成` outlined button pushed right (`margin-left:auto`, `107-109`).
- Visibility: `.actions { opacity:0 }` + `.alwaysShow` only for `isLast` (`95-105`, TSX `144`).
- Streaming: row removed entirely (`TSX:141`), only the stop button in the input card.

### 4.5 Thinking (深度思考) block — `ReplyArea`

- `ReplyArea.module.css:1-33`: `.area { margin-bottom:10px }`, `.title { height:34px; margin-bottom:2px; color:var(--dsw-alias-label-secondary) }`, `.titleIcon { margin-right:6px; color: var(--dsw-alias-brand-primary) }`, `.titleText { font: var(--dsw-font-markdown-base) }` = **16/28** — a 34px row with 28px line-height text.
- Active title uses a shimmer gradient (`.shimmer`, `35-50`); collapsed/expanded state is local (`ReplyArea.tsx:81`).
- Content typography: `thinking.markdown.css:1-3` → `--dsw-font-markdown-small` = **14/24**, `color: var(--dsw-alias-label-secondary)`; tighter margins (12px).
- Copy: `已思考（用时 {count} 秒）` / `正在思考` / `已停止` (`messageThinkDuration`, `messageThinking`, `messageThinkStopped`).
- Tool traces inside: `.steps` with 2px vertical connector, `.chip` rows, page links open `target=_blank` (`ReplyArea.tsx:273-292`).

### 4.6 Shared action components

| Component | Behaviour | Mobile note |
|---|---|---|
| `CopyButton.tsx` | `navigator.clipboard` → `execCommand` fallback (`utils/clipboard.ts:3-22`), toast `复制` / `已复制` | Android 13+ shows its own clipboard toast → double feedback |
| `ReadAloudButton.tsx` | server TTS PCM → `AudioContext` scheduled playback (`services/speech/readAloud.ts:78-129`), tooltip `朗读` / `停止朗读` | requires the tap gesture; AudioContext creation on Android must happen inside the gesture (it does) |
| `BranchSwitcher.tsx` | `‹ 2/5 ›`, `.count { 15/18 500 tertiary }`, `.switcher { height:28px; gap:2px }` | 28px height + 28px IconButtons is below the 44px touch target; sits left of the action row |
| `IconButton` | `xs 28 / m 34 / xl 44` (`IconButton.module.css`) | action rows use `xs` → **28px targets** |

### 4.7 Δ vs official app — chat screen

| # | Delta | Current | Target |
|---|---|---|---|
| C1 | **Actions hidden unless last message, hover only** | `opacity:0` + `.alwaysShow` on `isLast` (`UserMessage.module.css:57-71`, `AssistantMessage.module.css:95-105`) | always visible on `@media (hover:none)`; official shows `复制/朗读/重新生成` under every answer |
| C2 | Action row order | assistant: `版本 ← 复制 朗读 重新生成 → 继续生成`; user: `复制 编辑` then versions | official: `复制 · 朗读 · 重新生成` left-aligned under the answer, version pill `2/5` right-aligned |
| C3 | Touch targets | 28px IconButtons, 28px switcher | 40–44px hit area (`padding:8px`, keep 18px glyph) |
| C4 | Header height/safe area | 60px, no top inset | `height: calc(56px + env(safe-area-inset-top))`, `padding-top: env(safe-area-inset-top)` |
| C5 | User bubble | 22px radius, blue-50 (dark bluish-850), `max-width:100%−88px` | official ≈ 20px radius, `max-width: 78%`, `padding:10px 14px`, `16/24` |
| C6 | Assistant body | 16/28 with 20px gutters | official 16/26–28 with **16px** gutters; avatar-free (matches) |
| C7 | Thinking row | 34px, 16/28 label | official: 15/22 secondary label with chevron on the right, 32px row, `padding:0 4px` |
| C8 | Search summary | pill w/ 3 stacked thumbnails | official: `已阅读 N 个网页` row with favicon stack + chevron; tap → full-screen sheet (already full-screen on mobile: `SearchPanel.module.css:57-63` `position:fixed`) |
| C9 | Long-press | browser selection handles + system menu | official: custom bottom sheet (`复制/选择文本/引用/分享`) |
| C10 | No message avatar/spacing rhythm | `padding-bottom:16px` user, 6px assistant | official 24px between turns, 8px between assistant text and actions |

---

## 5. Settings dialog on mobile

`SettingsDialog.tsx:71-96` renders `<Modal>` with `title="设置"` (`71`), a `role="tablist"` `.navigation` (`81`), and a `role="tabpanel"` `.content` (`96`).

**It is not a full-screen page.** `Settings.module.css:291-303`:

```css
@media not all and (min-width: 768px) {
  .dialog { align-self: flex-end; width: 100%; max-width: none;
            height: calc(100% - 64px); max-height: 800px;
            border-radius: 24px 24px 0 0; }   /* bottom sheet, 64px peek */
}
```

- Surface: `Modal.module.css:1-15` overlay `rgba(0,0,0,.36)` (dark `.6`) + `backdrop-filter: blur(2px)`; content `width:380px` desktop / full width mobile, `border-radius:24px`, `box-shadow: inset 0 0 0 1px var(--dsw-alias-border-inverted), … --dsw-shadow-lv3`.
- Desktop chassis kept on mobile: `.dialog { width:760px; height:500px; padding:19px 24px 22px }` (`1-15`), `.navigation` column `width:172px` (`16-60`) reinterpreted as a **horizontal scrolling tab strip** with `min-width:108px` tabs (`305-329`).
- Content (`62-...`, mobile `330-336`): `padding: 0 24px`, `padding-top:24px`, `padding-bottom: env(safe-area-inset-bottom)` (dead, see §1.6).
- Rows `.cell`: `min-height:60px; padding:12px 0; 14/22` with inset divider shadow; mobile `.cellButton { min-height:44px }` and **`.cellButton svg { display:none }`** (`340`, `383`) → chevrons stripped, so rows no longer read as navigable.
- Theme row: 3 option cards `height:82px` (`themeOption`) instead of a single row with current value.
- Location row: 3 stacked `<Select>`s (province/city/region) inside one cell (`SettingsDialog.tsx:219-259`).
- API key: masked value cell + pill input (`height:52px; radius:40px; 16px` on mobile), confirm modals get `.mobileConfirm { height:52px; 17px; pill }` (`388-395`, media at `432`).

### Entries (tab **通用设置** `settingDialogAsideGeneralOptionLabel`)

| Row | i18n key | Control |
|---|---|---|
| 语言 | `settingsLocalePreference` | `<Select>` 简体中文 / English |
| 朗读音色 | `settingsTtsVoice` | `<Select>` 海星（女声）/ 暗潮（男声） |
| 主题 | `avatarMenuSettingsDialogThemeItemLabel` | 3 cards: 浅色 / 深色 / 跟随系统 |
| 位置信息 | `settingsLocation` | 3 `<Select>`: 省 / 市 / 国家或地区 |
| API Key | `apiKeyEdit` / `changeApiKey` | masked text + replace input (`apiKeyStart` when empty) |

### Entries (tab **数据管理** `settingDialogAsideDataOptionLabel`)

`导入历史对话` (`historyImport`, hidden `<input type=file accept=".zip,application/zip,…">`), `导出所有历史对话` (`exportAllLabel` + `exportAllDownload`), `删除所有对话` (`deleteAllSessions`). Confirm dialogs: `ImportConfirm`, `DeleteAllConfirm`, `DeleteConfirm`.

### Δ vs an app-like settings page

| # | Delta | Fix |
|---|---|---|
| S1 | **Bottom sheet, not a routed page** | render `SettingsDialog` as a full-height route/sheet: mobile `.dialog { height:100%; max-height:none; border-radius:0; width:100%; padding:0 }` + `Modal` overlay transparent on mobile |
| S2 | **Tab strip** inside the sheet | single scrolling page with section headers (`通用`, `数据`, `关于`); delete `.navigation` on mobile, keep `display:none` |
| S3 | **No header bar / back arrow** | 56px header w/ `‹` + `设置` centred, `env(safe-area-inset-top)` |
| S4 | **Rows 44–60px, chevrons hidden** | 56px rows, chevron re-enabled (`svg{display:block}`), value text right-aligned 14px tertiary |
| S5 | **Theme = 3 cards** | one row `主题` + value `跟随系统` → tap opens 3-row picker |
| S6 | **Location = 3 selects in a cell** | row `位置信息` + value → sub-page with 3 lists |
| S7 | Missing rows | `关于`, `版本 x.y.z` (available as `__APP_VERSION__`-style meta `application-version` in `rspack.config.ts` HtmlRspackPlugin), `隐私政策`, `用户协议`, `清除缓存` |
| S8 | API key row is a text input surface | row `API Key` + masked `sk-••••1234` + `更换` button opening native-style sheet |
| S9 | Missing destructive-section styling | `删除所有对话` should be a standalone red row at page bottom, not inside a card |

---

## 6. WebView / app-shell risks (concrete)

| # | Risk | Evidence | What breaks / feels non-native in Capacitor Android |
|---|---|---|---|
| R1 | **No `viewport-fit=cover`** | `src/index.html:5` `content="width=device-width,initial-scale=1"` | every `env(safe-area-inset-*)` computes to `0` (`Welcome.module.css:50`, `SessionView.module.css:68`, `Settings.module.css:333`); with Android 15 forced edge-to-edge the input card and bottom sheet sit under the gesture bar. Fix: `width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content` |
| R2 | **No top inset anywhere** | `MobileHeader.module.css:1-8`, `Sider.module.css:8`, `SessionView.module.css:8-16` | 44px menu button and drawer title render **behind the status bar**; official app has a 24–32px inset strip |
| R3 | **Double keyboard compensation** | `viewport.ts:71-75` writes `visualViewport.height` to `--app-viewport-height`; `App.module.css:57-60` makes the frame `position:fixed` with that height; `ChatInput.module.css:225` caps at `calc(var(--app-viewport-height,100dvh) - 120px)` | if Capacitor `Keyboard.resize:'native'`/`adjustResize` also shrinks the WebView, the input card floats **twice the keyboard height** above the bottom. Pick one: `resizes-content` + drop the visualViewport writer, or keep the writer with `resize:'none'` |
| R4 | **`visualViewport.scale !== 1` early-return** | `viewport.ts:61-65` | any pinch (allowed — no `maximum-scale`) freezes `--app-viewport-height` at the pre-pinch value → frame stuck at a stale height until refocus |
| R5 | **`touchmove` with `passive:false` + `getComputedStyle` walk** | `viewport.ts:13-43` | forces style recalc on every touch frame for each ancestor → scroll jank on mid-range Android; Chrome also warns about non-passive listeners. Better: `overscroll-behavior` + `touch-action` CSS only |
| R6 | **Hover-gated actions** | `UserMessage.module.css:11-13,57-71`; `AssistantMessage.module.css:4-7,95-105`; `ChatInput.module.css:280-282`; `IconButton.module.css` (`@media (hover:hover)`) | touch devices get sticky/never hover state; on Android the first tap may only trigger `:hover` (no action). Need `@media (hover:none)` → `opacity:1` |
| R7 | **`<input type=file>` with ~700 extensions** | `ChatInput.tsx:252-262` `accept={ACCEPT}`; `services/attachments.ts:11` builds `.ext` list from `services/uploadExts.ts` (~700 entries, no heic/heif) | Android's document picker ignores unknown extensions → shows a generic "文件" chooser, no 相机/相册/最近 split, no multi-source sheet. `multiple` (`:255`) works; no `capture`. Fix: native action sheet → `@capacitor/camera` (photos/camera) + `@capacitor/filesystem` picker; keep the input as fallback |
| R8 | **`getUserMedia` + mic permission** | `useVoiceInput.ts:15` `AVAILABLE = window.isSecureContext`; `services/speech/recorder.ts:24` `getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}})` | Capacitor serves `https://localhost` so `isSecureContext` is true, but the WebView permission prompt is **auto-denied** unless `RECORD_AUDIO` is in the manifest *and* the bridge grants `onPermissionRequest`. Failure surfaces only as toast `无法使用麦克风，请在浏览器设置中允许访问` (`voiceInputPermissionDenied`) — wrong text for an app |
| R9 | **Deprecated audio capture** | `recorder.ts:56-58` `new AudioContext({sampleRate:16000})` + `createScriptProcessor(4096,1,1)` | ScriptProcessor runs on the main thread in Android WebView → dropped frames/jank while recording, and it is deprecated in Chrome (removal planned). `AudioWorklet` + `@capacitor/microphone` or MediaRecorder→server is the robust path |
| R10 | **Clipboard double-toast** | `utils/clipboard.ts:3-4` `navigator.clipboard.writeText`; fallback `12-22` hidden `<textarea style="position:fixed;top:0;left:0;opacity:0;font-size:16px">` | works on `https://localhost`; Android 13+ shows a system "已复制" chip on top of the app toast `已复制` (`i18n` `copied`). Use `@capacitor/clipboard` and suppress the app toast |
| R11 | **ZIP export does nothing** | `SettingsDialog.tsx:527-532` `URL.createObjectURL(blob)` + `document.createElement('a'); a.download = name; a.click()`; archive built by `services/chat/history/exportArchive.ts` (fflate, in-memory) | Android WebView ignores the `download` attribute for `blob:` URLs (no `DownloadListener`), so tapping 下载 **silently fails**. Needs `@capacitor/filesystem` (write to `Cache`) + `@capacitor/share`. Also a full-history ZIP in memory can OOM on low-end devices |
| R12 | **Links open inside the WebView** | `markdown/Link.tsx:42,52` `<a target="_blank" rel="noreferrer">` (URL sanitized at `4-20`, https-only + mailto) | Capacitor's default `shouldOverrideUrlLoading` loads `_blank` in the same WebView → user leaves the SPA and cannot come back with the back button. Fix: intercept via `@capacitor/browser` + `will-navigate` guard, keep `mailto:` out |
| R13 | **Image/link long-press system menu** | `markdown.css:10` images; `Link.tsx:42,52` | Android shows "保存图片 / 复制链接地址 / 在浏览器中打开" — inconsistent with the official app's custom sheet; needs `oncontextmenu` prevent + `-webkit-touch-callout:none` |
| R14 | **Text selection everywhere** | only 3 `user-select:none` (`Welcome.module.css:66`, `Sider.module.css:117`, `ChatInput.tsx` placeholder `198-201`) | long-press on an assistant answer opens selection handles + floating toolbar that can overflow the WebView and fight the action row. Policy: `body{-webkit-user-select:none;user-select:none}`, re-enable on `.ds-markdown`, `textarea`, `input` |
| R15 | **No `enterkeyhint`/`inputmode`** | `ChatInput.tsx:160-196` textarea (Enter sends, Shift+Enter newline at `183-188`) | Android IME shows a newline key instead of `发送`; official shows 发送. Add `enterKeyHint="send"` + `autoCapitalize="off"` + `spellCheck={false}` + `autoCorrect="off"` |
| R16 | **Double-tap zoom** | `index.html:5` (no `maximum-scale`/`user-scalable`), no `touch-action` on `.toggle/.sendButton/.newChat/.item` | double tap on a chip zooms the whole fixed layout; `touch-action: manipulation` on interactive rows avoids the 300ms/dbl-tap ambiguity |
| R17 | **`backdrop-filter` on full-screen overlays** | `Modal.module.css:10` (`blur(2px)`), `DragMask.module.css:11-12` (`-webkit-` variant only) | soft-keyboard-open + blur on a 100%×100% overlay is a common Android jank/OOM source (GPU layer up to screen size). Use a solid `rgba(0,0,0,.4)` on mobile |
| R18 | **Sticky input inside a fixed frame** | `SessionView.module.css:32-35` `position:sticky; bottom:0`; mobile `62-69` switches to `position:relative` | during IME animation the gradient-to-transparent background (`43-49`) reveals message text through the input area for one frame; official uses a solid/blurred bar |
| R19 | **Two scroll containers swapped at 768px** | `MessageList.module.css:1-30`, breakpoint migration `MessageList.tsx:118+` | Android split-screen / rotation across 768px swaps scrollers; `scrollTop` is transplanted but the `ResizeObserver` in `72-82` re-pins to bottom on the next content change (position lost) |
| R20 | **No PWA/manifest, `publicPath:'auto'`** | `rspack.config.ts:66-70` (comment: file:// fallback) | harmless over `https://localhost`, but if you ever ship `file://` assets the async chunks + `HtmlRspackPlugin` defer script will fail → keep `https://localhost` (Capacitor default) |
| R21 | **`theme-color` is browser-only** | `theme.ts:25-29` sets `<meta name="theme-color">` | Android WebView ignores it; the status bar stays default until you call `@capacitor/status-bar` `setBackgroundColor`/`setStyle` on every theme change (`theme.ts:32-51` is the single hook) |
| R22 | **No haptics / no ripple** | all buttons are CSS-only (`Button.module.css:17-21` `:focus-visible` ring) | taps feel dead compared to the native app; add `@capacitor/haptics` `impact({style:'light'})` on the send/stop/session rows and `:active { transform: scale(.97) }` |
| R23 | **`-webkit-*` specifics that are safe, listed for completeness** | `-webkit-text-size-adjust:none` (`global.css:21`), `-webkit-line-clamp` (`ChatInput.module.css:134`, `SourceCard`), `-webkit-backdrop-filter` only in `DragMask.module.css:12` | all supported by Chrome ≥105 (the build target in `rspack.config.ts:11`), no action needed |

---

## 7. i18n keys to reuse / add (app-style copy)

`src/i18n/zh.ts` (172 lines) is the source of truth: `type TranslationKey = keyof typeof zh` (`i18n/index.ts`), `en.ts` mirrors it 1:1 (181 lines, same order).

### Reuse as-is

| Key | zh value | Where used |
|---|---|---|
| `welcomeMessageChat250808` | `今天有什么可以帮到你？` | `Welcome.tsx:15` |
| `contentCaveat` | `内容由 AI 生成，请仔细甄别` | `Welcome.tsx:17`, `SessionView.tsx:40` |
| `chatInputPlaceholderChat` | `请输入消息` | `ChatInput.tsx` textarea |
| `thinkingSwitch` | `深度思考` | `ChatInput.tsx:214` |
| `search` | `智能搜索` | `ChatInput.tsx:226` |
| `deactivatedThinkTooltip` | `先思考后回答，解决推理问题` | `ChatInput.tsx:205` |
| `deactivatedSearchTooltip` | `按需搜索网页` | `ChatInput.tsx:217` |
| `uploadFile` | `上传文件` | `ChatInput.tsx:248` |
| `voiceInput` | `语音输入` | `VoiceButton` |
| `send` / `copy` / `copied` | `发送` / `复制` / `已复制` | action rows |
| `newChat` / `untitledChat` | `开启新对话` / `新对话` | drawer pill, header, title fallback |
| `appName` | `API 使用 demo` | `Sider.tsx:55` ← **replace for app** |
| `expandSiderbarButton` / `collapseSiderbarButton` | `打开边栏` / `收起边栏` | `MobileHeader.tsx:17`, `Sider.tsx:59` |
| `settings` | `设置` | drawer footer, dialog title |
| `sessionHistoryTimelineLabelToday` … `7days` / `30days` | `今天` / `昨天` / `7 天内` / `30 天内` | `sessionGroups.ts:16-29` |
| `editMessage` / `regenerate` / `continueGenerating` | `编辑消息` / `重新生成` / `继续生成` | message actions |
| `messageVersions` | `消息版本` | `BranchSwitcher` aria |
| `ttsPlay` / `ttsStop` / `ttsUnavailable` | `朗读` / `停止朗读` / `这条回答暂时无法朗读` | `ReadAloudButton` |
| `settingDialogAsideGeneralOptionLabel` / `…DataOptionLabel` | `通用设置` / `数据管理` | settings tabs |
| `settingsLocalePreference` | `语言` | settings row |
| `settingsTtsVoice` (+`…Stella` `海星（女声）`, `…Tide` `暗潮（男声）`) | `朗读音色` | settings row |
| `avatarMenuSettingsDialogThemeItemLabel` (+`浅色` / `深色` / `跟随系统`) | `主题` | settings row |
| `settingsLocation` (+`请选择省份/地区`, `请选择市`, `请选择国家或地区`) | `位置信息` | settings row |
| `apiKeyStart` / `apiKeyEdit` / `changeApiKey` | `输入 API Key 开始使用` / `修改 API Key` / `更换 API Key` | key row |
| `historyImport` / `confirm` / `cancel` / `delete` | `导入历史对话` / `确定` / `取消` / `删除` | data tab |
| `exportAllLabel` / `exportAllDownload` | `导出所有历史对话` / `下载` | data tab |
| `deleteAllSessions` | `删除所有对话` | data tab |
| `voiceInputPermissionDenied` | `无法使用麦克风，请在浏览器设置中允许访问` | ← **needs app wording** |
| `voiceInputRequiresHttps` | `非 HTTPS 页面无法使用语音输入` | dead in app shell |
| `uploadMaxFiles` | `上传文件最多支持 {count} 个` | toasts |

### Add (suggested keys → zh)

```
settingsAbout: '关于'                 settingsVersion: '版本 {version}'
settingsPrivacy: '隐私政策'            settingsTerms: '用户协议'
settingsClearCache: '清除缓存'         settingsClearCacheDone: '已清除'
appTitle: 'DeepSeek'                  homeSuggestionTitle: '试试这样问'
homeSuggestion1..4: '写一段自我介绍' / '解释一下量子纠缠' / '帮我写一封邮件' / '总结这段话'
attachSheetTitle: '上传文件'           attachSheetCamera: '拍照'  attachSheetPhotos: '相册'
attachSheetFiles: '文件'
messageMenuTitle: '消息操作'           messageMenuSelect: '选择文本'
messageMenuQuote: '引用'              messageMenuShare: '分享'
exportShareTitle: '导出历史对话'        exportShareFailed: '导出失败，请重试'
openInBrowser: '在浏览器中打开'         linkOpenFailed: '无法打开链接'
micPermissionAppDenied: '请在系统设置中允许麦克风权限'
backButton: '返回'                    drawerAccount: '我的'
```
Mirror every addition in `src/i18n/en.ts` (same order — the file is hand-maintained, no codegen).

---

## 8. Prioritized change list

### P0 — required before the APK feels like an app

| # | Change | Files | Current → Target |
|---|---|---|---|
| P0-1 | **Safe-area foundation** | `src/index.html:5` | `initial-scale=1` → `width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content` |
| P0-2 | Apply insets | `MobileHeader.module.css:1-8`, `Sider.module.css:8`, `Settings.module.css:1-15`, `SessionView.module.css:62-69`, `Welcome.module.css:44-51` | `height:60px` → `height:calc(56px + env(safe-area-inset-top)); padding-top:env(safe-area-inset-top)`; drawer `padding-top: calc(6px + env(safe-area-inset-top))` |
| P0-3 | **One keyboard strategy** | `src/app/viewport.ts:46-108`, `src/app/App.module.css:55-61`, `src/components/chatInput/ChatInput.module.css:222-226` | delete `--app-viewport-height` writer (and `viewport.ts:35-43` non-passive touchmove) **or** set Capacitor `Keyboard.resize:'none'`; keep exactly one |
| P0-4 | **Always-visible message actions** | `UserMessage.module.css:57-71`, `AssistantMessage.module.css:95-105` | add `@media (hover:none) { .actions { opacity:1 } }`; bump `IconButton` hit area to 40px in action rows |
| P0-5 | **Drawer scrim + slide** | `Sider.module.css:195-207`, `Sider.tsx:149-160`, `mobileSiderState.ts` | mask `background: rgba(0,0,0,.32)`; panel `transform: translateX(-100%)` + `[data-open] { transform:none }`, `transition:.25s cubic-bezier(.4,0,.2,1)`; width `300px` → `min(88vw,360px)` |
| P0-6 | **External links** | `components/markdown/Link.tsx:42,52`, new `services/links.ts` | `target=_blank` intercepted → `Browser.open()`; block in-WebView navigation |
| P0-7 | **History ZIP export** | `components/settings/SettingsDialog.tsx:527-532` | anchor+blob → `Filesystem.writeFile(Cache)` + `Share.share()` |
| P0-8 | **Message-page top bar** | `MobileHeader.module.css:1-19`, `MobileHeader.tsx:9-33` | 60px → `calc(56px + inset)`; title `500 14/22` → `600 16/22`; icon buttons stay 44px |
| P0-9 | **Selection / context-menu policy** | `src/app/global.css:13-29`, `markdown.css` | `body { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none }`; `.ds-markdown, textarea, input { user-select:text }`; `oncontextmenu` guard on `img`/`a` |
| P0-10 | **Mic permission path** | `android/app/src/main/AndroidManifest.xml` (new), `useVoiceInput.ts:15`, `recorder.ts:24` | declare `RECORD_AUDIO`; replace `voiceInputPermissionDenied` copy with `micPermissionAppDenied`; migrate `createScriptProcessor` → `AudioWorklet` |
| P0-11 | **IME send key** | `ChatInput.tsx:160-196` | add `enterKeyHint="send" autoCapitalize="off" autoCorrect="off" spellCheck={false}` |

### P1 — visual parity with the official app

| # | Change | Files | Current → Target |
|---|---|---|---|
| P1-1 | Home logo + greeting anchor | new `components/session/BrandMark.tsx`, `Welcome.tsx:14-18`, `Welcome.module.css:39-67` | `.greeting { margin:auto 0 }` → `.homeTop { padding-top: 18vh }`; logo 56px above; greeting 20/28 500 at all widths; delete `@media (max-width:439px)` size step |
| P1-2 | Suggestion chips | new `components/session/SuggestionChips.tsx` + css, mount before `ChatInput` | none → 2×2 grid, 44px, radius 16, `background: var(--dsw-specific-sidebar-fill)`, `border:1px solid var(--dsw-alias-border-l2)`, `14/22` |
| P1-3 | Toggle chips | `ChatInput.module.css:258-298` | `transparent + 1px border`, 34px/18px radius → `background: var(--dsw-alias-bg-skeleton)` (off) / `ghost-active-fill` (on), `border:none`, 32px/16px, 13/20 |
| P1-4 | Send button | `ChatInput.module.css:308-332` | 34px + shadow-none, `margin-left:6px` → 32px, arrow-up glyph, `margin-left:8px`, `:active { transform: scale(.94) }` |
| P1-5 | Input card surface | `ChatInput.module.css:1-32` | radius 24 → 26; `.home` triple shadow → `0 2px 12px rgba(0,0,0,.06)`; keep dark `none` |
| P1-6 | User bubble | `UserMessage.module.css:30-47` | radius 22 → 20, `max-width: calc(100% − 88px)` / `−68px` → `78%`, `padding:10px 14px` |
| P1-7 | Action row order & spacing | `AssistantMessage.tsx:141-175`, `AssistantMessage.module.css:84-105` | `left:-6px` → `left:0`; order `版本 · 复制 · 朗读 · 重新生成`; `gap:10px` → `16px`; version pill right-aligned |
| P1-8 | Thinking row | `ReplyArea.module.css:5-33` | `height:34px`, `16/28` → `height:32px`, `15/22`, chevron right, `padding:0 4px` |
| P1-9 | Settings as page | `Settings.module.css:291-340`, `SettingsDialog.tsx:71-96` | sheet `calc(100% − 64px)` → `height:100%; border-radius:0`; hide `.navigation`; `.cell { min-height:56px }`; re-enable chevrons (`383`); header with `‹` + `设置` + inset |
| P1-10 | Settings rows to sub-pages | `SettingsDialog.tsx:277-320` (theme/locale/voice), `:219-259` (location) | inline `<Select>`/3 cards → row + value + sub-page list |
| P1-11 | Drawer header/footer | `Sider.tsx:54-63,94-100`, `Sider.module.css:25-35,120-169` | brand wordmark instead of `appName`; remove collapse icon on mobile; add 56px account row above 设置 |
| P1-12 | File attach sheet | `ChatInput.tsx:244-262`, new `AttachSheet.tsx` | hidden input → native-style sheet 拍照/相册/文件 (Camera + Filesystem plugins), keep input as fallback |
| P1-13 | Overlay cost | `Modal.module.css:9-10`, `DragMask.module.css:11-12` | mobile: drop `backdrop-filter`, solid `rgba(0,0,0,.4)` |
| P1-14 | Scroll/overscroll polish | `MessageList.module.css:15-30`, `ChatInput.module.css:34-41`, `Settings.module.css:305-329` | add `overscroll-behavior-x: contain` to horizontal strips; `scrollbar-width:none` on mobile; hide the gradient seam (`SessionView.module.css:43-49` → solid `var(--dsw-alias-bg-base)`) |

### P2 — polish / native feel

| # | Change | Files |
|---|---|---|
| P2-1 | Haptics on send / stop / session tap / toggle (`@capacitor/haptics`) | `ChatInput.tsx:206-285`, `SessionItem.tsx` |
| P2-2 | Ripple or `:active` scale on all pressables; remove `:hover`-only styles under `(hover:none)` | `Button.module.css`, `Sider.module.css:37-75`, `SessionItem.module.css:19` |
| P2-3 | Status bar sync with theme (`@capacitor/status-bar`) | `src/app/theme.ts:32-51` (after `applyTheme`), `theme.ts:25-29` |
| P2-4 | Splash/launch background = `--dsw-alias-bg-base`; `theme-color` already synced | `src/index.html:6`, Capacitor `styles.xml` |
| P2-5 | Toast repositioned above keyboard / bottom-inset aware | `components/base/Toast.module.css` |
| P2-6 | Long-press message menu (复制/选择/引用/分享) replacing browser selection | new `MessageActionSheet.tsx`, `AssistantMessage.tsx` |
| P2-7 | `touch-action: manipulation` on interactive rows; forbid double-tap zoom at the app level | `global.css:13`, component CSS |
| P2-8 | Radius/spacing tokens to kill the literals (`--ds-radius-s/m/l/xl/pill`) | `src/app/theme.css:8-26` + the 8 files listed in §1.5 |
| P2-9 | Cache/size guard for ZIP export (fflate in-memory) | `services/chat/history/exportArchive.ts` |
| P2-10 | Replace `API 使用 demo` strings (`appName`) with app name everywhere it leaks | `i18n/zh.ts:14`, `i18n/en.ts:17`, drawer/`index.html:7` title |

---

### Appendix — numbers to design against

- Breakpoint: `768px`; secondary `440px`, `1023px`.
- Header: 60px (mobile) / 60px + 113px collapsed offset (desktop).
- Home gutters: 16px; chat column gutters: 20px; input card: `100% − 32px`.
- Input card height at rest: `42px` (1.25 lines) + `62px` (function row) = **104px**; caveat **28px**.
- Drawer: `300px`, max `100vw − 48px`; item 44px; section label 14/22.
- Settings sheet: `height: calc(100% − 64px)`, max 800px, radius `24px 24px 0 0`.
- Touch targets currently below 44px: `IconButton xs` 28px, `.sendButton` 34px, `.toggle` 34px, `BranchSwitcher` 28px, `.newChat` 40px.
