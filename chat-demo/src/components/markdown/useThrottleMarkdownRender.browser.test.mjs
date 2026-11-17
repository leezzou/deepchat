import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Reuse the repository's existing browser tooling; this test does not enter the app bundle.
const requireTools = createRequire(new URL('../../../../tools/package.json', import.meta.url))
const { chromium } = requireTools('playwright')
const project = new URL('../../../', import.meta.url)
const streaming = stripTypeScriptTypes(
  await readFile(new URL('../../services/markdown/streaming.ts', import.meta.url), 'utf8')
).replaceAll('export function ', 'function ')
const hook = stripTypeScriptTypes(
  await readFile(new URL('./useThrottleMarkdownRender.ts', import.meta.url), 'utf8')
)
  .replace(/^import .*\n/gm, '')
  .replace('export const useThrottleMarkdownRender', 'const useThrottleMarkdownRender')

async function mount(page) {
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({
    path: fileURLToPath(new URL('node_modules/react/umd/react.development.js', project)),
  })
  await page.addScriptTag({
    path: fileURLToPath(new URL('node_modules/react-dom/umd/react-dom.development.js', project)),
  })
  await page.addScriptTag({
    content: `
    const {useEffect, useLayoutEffect, useRef, useState} = React;
    ${streaming}
    ${hook}
    window.snapshots = [];
    function Probe({content, loading = true, cacheKey = 'a', pendingCharacters = 0}) {
      const shown = useThrottleMarkdownRender(content, loading, cacheKey, pendingCharacters);
      useLayoutEffect(() => {window.snapshots.push({length: shown.length, time: performance.now()})}, [shown]);
      return React.createElement('pre', {id: 'text'}, shown);
    }
    window.root = ReactDOM.createRoot(document.getElementById('root'));
    window.renderProbe = (props) => ReactDOM.flushSync(() => root.render(React.createElement(Probe, props)));
    renderProbe({content: ''});
  `,
  })
}

test('stream hook smooths bursts, flushes completion, resets identity and stops timers in browser', async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : {}),
  })
  try {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
    ]) {
      const page = await browser.newPage({ viewport })
      await mount(page)
      const content = '流式正文😀'.repeat(1000)
      await page.evaluate((content) => renderProbe({ content }), content)
      await page.waitForTimeout(85)
      const partial = await page.locator('#text').textContent()
      assert.ok(partial.length > 0 && partial.length < content.length)
      assert.ok(content.startsWith(partial))
      assert.ok(await page.evaluate(() => snapshots.length > 2))
      assert.equal(
        await page.evaluate((content) => {
          renderProbe({ content, loading: false })
          return document.getElementById('text').textContent
        }, content),
        content,
        'completion must flush synchronously'
      )
      assert.equal(
        await page.evaluate(() => {
          renderProbe({ content: '替换正文', loading: true })
          return document.getElementById('text').textContent
        }),
        '替换正文'
      )
      assert.equal(
        await page.evaluate(() => {
          renderProbe({ content: '换消息立即显示', loading: true, cacheKey: 'b' })
          return document.getElementById('text').textContent
        }),
        '换消息立即显示'
      )
      await page.evaluate(() => {
        renderProbe({ content: '换消息立即显示' + '新'.repeat(5000), cacheKey: 'b' })
        ReactDOM.flushSync(() => root.unmount())
      })
      const count = await page.evaluate(() => snapshots.length)
      await page.waitForTimeout(260)
      assert.equal(await page.evaluate(() => snapshots.length), count)
      await page.close()
    }

    const continuous = await browser.newPage()
    await mount(continuous)
    const progress = await continuous.evaluate(async () => {
      let content = ''
      const timer = setInterval(() => {
        content += '持续输入'.repeat(30)
        renderProbe({ content })
      }, 5)
      await new Promise((resolve) => setTimeout(resolve, 130))
      clearInterval(timer)
      return {
        updates: snapshots.length,
        length: document.getElementById('text').textContent.length,
      }
    })
    assert.ok(
      progress.updates > 2 && progress.length > 0,
      'frequent input must not restart the timer forever'
    )
    await continuous.close()

    const large = await browser.newPage()
    await mount(large)
    await large.evaluate(() =>
      renderProbe({ content: '长'.repeat(100_000), pendingCharacters: 60_000 })
    )
    await large.waitForTimeout(110)
    assert.equal(await large.locator('#text').textContent(), '')
    await large.waitForTimeout(110)
    const length = (await large.locator('#text').textContent()).length
    assert.ok(length > 0 && length < 100_000)
    assert.equal(
      await large.evaluate(() => {
        renderProbe({ content: '长'.repeat(100_000), pendingCharacters: 60_000, loading: false })
        return document.getElementById('text').textContent.length
      }),
      100_000
    )
    await large.close()

    const reduced = await browser.newPage()
    await reduced.emulateMedia({ reducedMotion: 'reduce' })
    await mount(reduced)
    await reduced.evaluate(() => renderProbe({ content: '静'.repeat(4000) }))
    await reduced.waitForTimeout(60)
    assert.equal((await reduced.locator('#text').textContent()).length, 4000)
    await reduced.close()
  } finally {
    await browser.close()
  }
})
