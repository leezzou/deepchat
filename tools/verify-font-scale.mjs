// 聊天字号回归：在生产构建上以 390px 移动端对话测量 Markdown/思考/工具文字的实际 computed fontSize。
// 用法：node tools/verify-font-scale.mjs [构建产物目录] [证据目录]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const assets = path.resolve(process.argv[2] || 'chat-demo/dist')
const out = path.resolve(
  process.argv[3] || `tmp/font57-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}`
)
await mkdir(out, { recursive: true })

const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const file = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname))
    assert.ok(file.startsWith(assets + path.sep), 'asset path escapes build directory')
    const body = await readFile(file)
    res
      .writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' })
      .end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

const indexHtml = await readFile(path.join(assets, 'index.html'), 'utf8')
const entry = indexHtml.match(/<script[^>]*src="([^"]*main\.[^"]+\.js)"/)?.[1]
const version =
  indexHtml.match(/<meta content="([^"]+)" name="application-version"/)?.[1] ||
  indexHtml.match(/<meta name="application-version" content="([^"]+)"/)?.[1]
assert.ok(version && entry, 'versioned production bundle required')
const sha256 = createHash('sha256')
  .update(await readFile(path.join(assets, entry)))
  .digest('hex')

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
})
const report = {
  version,
  entry,
  sha256,
  browser: browser.version(),
  viewport: { width: 390, height: 844 },
  generatedAt: new Date().toISOString(),
  cases: [],
  comparisons: [],
  assertions: [],
  errors: [],
  blockedHosts: [],
}

const TITLE = '字号回归会话'
const SESSION_ID = 'font57'
const USER_ID = 'font57-user'
const REPLY_ID = 'font57-reply'

const userText = '请按标题、列表、表格、代码和公式展示聊天字号效果。'
const answerMarkdown = [
  '# 一级标题 Font 57',
  '',
  '## 二级标题 Font 57',
  '',
  '### 三级标题 Font 57',
  '',
  '#### 四级标题 Font 57',
  '',
  '正文段落 Font 57，包含 `inline_code` 与 **加粗文字**。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用块 Font 57',
  '',
  '| 表头 A | 表头 B |',
  '| --- | --- |',
  '| 单元格 1 | 单元格 2 |',
  '',
  '```ts',
  'const fontSize = 16',
  'console.log(fontSize)',
  '```',
  '',
  '行间公式：',
  '',
  '$$',
  'a^2 + b^2 = c^2',
  '$$',
].join('\n')

const thinkingMarkdown = '思考段落 Font 57：先核对标题、表格、代码块与工具行的字号倍率。'

const blocks = [
  { type: 'thinking', thinking: thinkingMarkdown, startedAt: Date.now() - 2000, endedAt: Date.now() - 1000 },
  {
    type: 'server_tool_use',
    id: 'srvtoolu_s_1_font57',
    name: 'deepseek_web_search',
    input: { action: 'search', query: '聊天字号', queries: ['聊天字号'] },
    caller: { type: 'direct' },
    kind: 'search',
  },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_s_1_font57',
    kind: 'search',
    content: [
      {
        type: 'web_search_result',
        title: '字号测试结果',
        url: 'https://example.com/font57',
        snippet: '用于验证工具行字号。',
        site_icon: null,
        site_name: 'example.com',
        encrypted_content: '',
        page_age: null,
      },
    ],
  },
  {
    type: 'server_tool_use',
    id: 'srvtoolu_rl_2_font57',
    name: 'deepseek_read_url',
    input: { action: 'open_page', url: 'https://example.com/font57-open' },
    caller: { type: 'direct' },
    kind: 'read_link',
  },
  {
    type: 'web_fetch_tool_result',
    tool_use_id: 'srvtoolu_rl_2_font57',
    kind: 'read_link',
    content: {
      type: 'web_fetch_result',
      url: 'https://example.com/font57-open',
      content: {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: '' },
        title: '字号工具页',
      },
      published_at: null,
    },
  },
  {
    type: 'server_tool_use',
    id: 'srvtoolu_f_3_font57',
    name: 'deepseek_web_search',
    input: { action: 'find_in_page', url: 'https://example.com/font57-open', pattern: '字号' },
    caller: { type: 'direct' },
    kind: 'deep_search',
  },
  {
    type: 'web_fetch_tool_result',
    tool_use_id: 'srvtoolu_f_3_font57',
    kind: 'deep_search',
    content: {
      type: 'web_fetch_result',
      url: 'https://example.com/font57-open',
      content: {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: '' },
        title: '字号工具页',
      },
      published_at: null,
    },
  },
  { type: 'text', text: answerMarkdown },
]

async function seedSession(page) {
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some((db) => db.name === 'chat-demo' && db.version >= 12)
  )
  await page.evaluate(
    async ({ title, sessionId, userId, replyId, userText, blocks }) => {
      const open = indexedDB.open('chat-demo')
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      const now = Date.now()
      const messages = [
        { id: userId, role: 'user', content: userText, files: [], createdAt: now, parentId: null, selectedChildId: replyId },
        { id: replyId, role: 'assistant', status: 'done', createdAt: now + 1, parentId: userId, blocks },
      ]
      const base = { id: sessionId, title, createdAt: now, updatedAt: now + 1, fileIds: [] }
      tx.objectStore('sessionSummaries').put(base)
      tx.objectStore('sessions').put({ ...base, rootMessageId: userId, messages })
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    { title: TITLE, sessionId: SESSION_ID, userId: USER_ID, replyId: REPLY_ID, userText, blocks }
  )
}

const selectors = {
  h1: `.ds-assistant-message-main-content h1`,
  h2: `.ds-assistant-message-main-content h2`,
  h3: `.ds-assistant-message-main-content h3`,
  h4: `.ds-assistant-message-main-content h4`,
  paragraph: `.ds-assistant-message-main-content .ds-markdown-paragraph`,
  listItem: `.ds-assistant-message-main-content li`,
  tableCell: `.ds-assistant-message-main-content td`,
  blockquote: `.ds-assistant-message-main-content blockquote`,
  codeBlock: `.ds-assistant-message-main-content .md-code-block pre`,
  inlineCode: `.ds-assistant-message-main-content .ds-markdown-paragraph code`,
  thinkingText: `.ds-think-content .ds-markdown .ds-markdown-paragraph`,
  thinkingTitle: `[data-reply-thinking] span[class*="titleText"]`,
  searchRow: `[data-search-step="done"]`,
  toolBody: `[data-message-id="${REPLY_ID}"] div[class*="toolBody-"]`,
  chip: `[data-message-id="${REPLY_ID}"] span[class*="chip-"]`,
  sourceSummary: `[data-search-sources]`,
  userBubble: `[data-message-id="${USER_ID}"] [class*="bubble"]`,
}

async function measure(page) {
  return page.evaluate(
    ({ replyId, selectors }) => {
      const scope = document.querySelector(`[data-message-id="${replyId}"]`)
      const first = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const style = getComputedStyle(el)
        return {
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: style.lineHeight,
          text: (el.textContent || '').trim().slice(0, 36),
        }
      }
      const out = {}
      for (const [key, selector] of Object.entries(selectors)) {
        // h1/h2… 等选择器限定在助手消息内，避免命中页面其它区域
        const scoped = selector.startsWith('[data-') ? selector : `${scope ? `[data-message-id="${replyId}"] ` : ''}${selector}`
        out[key] = first(scoped)
      }
      const root = getComputedStyle(document.documentElement)
      return { fonts: out, rootFontSize: Number.parseFloat(root.fontSize) }
    },
    { replyId: REPLY_ID, selectors }
  )
}

async function openSettings(page) {
  await page.locator('textarea:visible').first().waitFor()
  const entryButton = page.getByRole('button', { name: '设置', exact: true })
  if (!(await entryButton.isVisible())) {
    await page.getByRole('button', { name: /^打开边栏/ }).click()
  }
  await entryButton.click()
  await page.locator('[data-theme-picker]:visible').waitFor()
}

const expectedBase = {
  h1: 24,
  h2: 22,
  h3: 18,
  h4: 16,
  paragraph: 16,
  listItem: 16,
  tableCell: 14,
  blockquote: 16,
  codeBlock: 13,
  inlineCode: 14,
  thinkingText: 14,
  thinkingTitle: 14,
  searchRow: 13,
  toolBody: 13,
  chip: 13,
  sourceSummary: 13,
  userBubble: 16,
}

try {
  for (const scale of [0.85, 1, 1.3]) {
    const record = { scale, checks: [], errors: [], shots: [], fonts: {}, rootFontSize: null, settingsRootFontSize: null, settingsChromeFontSize: null }
    report.cases.push(record)
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      colorScheme: 'light',
      serviceWorkers: 'block',
    })
    try {
      await context.addInitScript(
        ({ scale }) => {
          localStorage.setItem('chat-demo:locale', 'zh-CN')
          localStorage.setItem('chat-demo:font-scale', String(scale))
          localStorage.setItem('chat-demo:theme-preference', 'light')
          localStorage.setItem(
            'chat-demo:api-profiles',
            JSON.stringify([
              {
                id: 'font57-profile',
                name: '字号测试方案',
                apiKey: 'fixture-only',
                protocol: 'deepseek',
                origin: 'https://api.deepseek.com',
                model: 'deepseek-chat',
              },
            ])
          )
          localStorage.setItem('chat-demo:active-profile', 'font57-profile')
        },
        { scale }
      )
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        // 应用启动会检查更新，离线验证时直接拦截；它不属于页面错误。
        if (!report.blockedHosts.includes(url.origin)) report.blockedHosts.push(url.origin)
        return route.abort()
      })
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.setDefaultNavigationTimeout(30000)
      page.on('pageerror', (error) => record.errors.push(error.message))
      await page.goto(origin)
      const sidebarButton = page.getByRole('button', { name: /^打开边栏/ })
      await sidebarButton.waitFor()
      await seedSession(page)
      await page.reload()
      await sidebarButton.waitFor()
      const applied = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--msg-font-scale').trim()
      )
      assert.equal(Number.parseFloat(applied), scale, `scale ${scale} applied to documentElement`)

      // 打开会话
      await sidebarButton.click()
      await page.getByText(TITLE, { exact: true }).first().click()
      await page.locator(`[data-message-id="${REPLY_ID}"]`).waitFor()

      // 思考默认可能折叠，展开后测量
      const thinkingTitle = page.locator('[data-reply-thinking]')
      if (await thinkingTitle.count()) {
        if ((await thinkingTitle.getAttribute('aria-expanded')) === 'false') await thinkingTitle.click()
      }
      await page.locator(selectors.thinkingText).waitFor()

      const data = await measure(page)
      record.fonts = data.fonts
      record.rootFontSize = data.rootFontSize
      assert.equal(data.rootFontSize, 16, `scale ${scale}: app root font-size must stay 16px`)

      for (const [key, expected] of Object.entries(expectedBase)) {
        const font = data.fonts[key]
        assert.ok(font, `scale ${scale}: missing ${key} (${selectors[key]})`)
        assert.ok(
          Math.abs(font.fontSize - expected * scale) < 0.6,
          `scale ${scale}: ${key} expected ${(expected * scale).toFixed(2)}px, got ${font.fontSize}px`
        )
      }
      record.checks.push('all measured chat text scales exactly once')

      await page.screenshot({ path: path.join(out, `chat-${scale}.png`), fullPage: false })
      record.shots.push(`chat-${scale}.png`)
      await page
        .locator(`[data-message-id="${REPLY_ID}"]`)
        .screenshot({ path: path.join(out, `reply-${scale}.png`) })
      record.shots.push(`reply-${scale}.png`)
      const codeBlock = page.locator(`${selectors.codeBlock}`)
      await codeBlock.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(out, `chat-lower-${scale}.png`), fullPage: false })
      record.shots.push(`chat-lower-${scale}.png`)
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(scrollWidth <= 391, `scale ${scale}: 390px viewport has horizontal overflow (${scrollWidth}px)`)
      record.checks.push('390px viewport has no horizontal overflow')

      // 设置页：root 与页面 chrome 字号不随聊天字号变化
      await openSettings(page)
      const settingsMetrics = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement)
        const picker = document.querySelector('[data-theme-picker]')
        return {
          rootFontSize: Number.parseFloat(root.fontSize),
          chromeFontSize: picker ? Number.parseFloat(getComputedStyle(picker).fontSize) : null,
        }
      })
      record.settingsRootFontSize = settingsMetrics.rootFontSize
      record.settingsChromeFontSize = settingsMetrics.chromeFontSize
      assert.equal(settingsMetrics.rootFontSize, 16, `scale ${scale}: settings page root font-size must stay 16px`)
      record.checks.push('settings root font-size unaffected')
      await page.screenshot({ path: path.join(out, `settings-${scale}.png`), fullPage: false })
      record.shots.push(`settings-${scale}.png`)
    } catch (error) {
      record.errors.push(String(error.stack || error))
      throw error
    } finally {
      await context.close()
    }
  }

  const small = report.cases.find((item) => item.scale === 0.85)
  const large = report.cases.find((item) => item.scale === 1.3)
  assert.ok(small && large)
  const expectedRatio = 1.3 / 0.85
  for (const key of Object.keys(expectedBase)) {
    const a = small.fonts[key]?.fontSize
    const b = large.fonts[key]?.fontSize
    assert.ok(a && b, `missing comparison for ${key}`)
    const ratio = b / a
    const passed = ratio > 1.4
    report.comparisons.push({
      key,
      small: a,
      large: b,
      ratio: Number(ratio.toFixed(3)),
      expectedRatio: Number(expectedRatio.toFixed(3)),
      delta: Number((b - a).toFixed(2)),
      passed,
    })
    assert.ok(passed, `${key}: 1.3 (${b}px) must be clearly larger than 0.85 (${a}px), ratio ${ratio.toFixed(3)}`)
    assert.ok(
      Math.abs(ratio - expectedRatio) < 0.05,
      `${key}: ratio ${ratio.toFixed(3)} suggests repeated scaling (expected ${expectedRatio.toFixed(3)})`
    )
  }
  report.assertions.push('all chat font sizes at 1.3 are clearly larger than at 0.85')
  report.assertions.push('all measured ratios match 1.3/0.85, so no double scaling')
  report.assertions.push('settings page root font-size stays 16px at every scale')
  assert.deepEqual(report.errors, [], 'no browser page errors')
} catch (error) {
  report.failure = String(error.stack || error)
  process.exitCode = 1
} finally {
  await browser.close()
  server.close()
  await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ out, failure: report.failure || null, cases: report.cases.length }, null, 2))
}
