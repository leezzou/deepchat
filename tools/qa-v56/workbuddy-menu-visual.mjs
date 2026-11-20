// Visual acceptance of WorkBuddy rate text, independently of the model/receipt test.
import assert from 'node:assert/strict'
import { runner } from './browser.mjs'
import { installHunyuanPort } from './hunyuan-fixture.mjs'

async function catalog({ page, shot, record }) {
  const trigger = page.locator('[data-model-menu-trigger]')
  const menu = page.locator('[data-quick-model-menu]')
  await trigger.click()
  const search = menu.getByRole('searchbox')
  await search.fill('hy3')
  const free = menu.locator('[data-model-id=hy3]')
  const paid = menu.locator('[data-model-id=hy3-x]')
  const unknown = menu.locator('[data-model-id=hy3-preview]')
  await unknown.waitFor()
  assert.match(await free.innerText(), /免费/)
  assert.match(await paid.innerText(), /0\.05/)
  assert.match(await unknown.innerText(), /未提供费率/)
  await shot('rates')
  await paid.click()
  await menu.waitFor({state:'detached'})
  assert.match(await trigger.getAttribute('aria-label'), /hy3-x/i)
  await trigger.click()
  const selected = menu.getByRole('option', {selected:true})
  assert.equal(await selected.getAttribute('data-model-id'), 'hy3-x')
  const rect = await selected.boundingBox()
  assert.ok(rect && rect.x>=0 && rect.x+rect.width<=record.width+1)
  assert.ok(await selected.evaluate(el=>el.contains(document.elementFromPoint(el.getBoundingClientRect().x+32,el.getBoundingClientRect().y+12))))
  await shot('selected')
  record.checks.push('Matched free/paid/undisclosed rates', 'Duplicate model names disambiguated in composer', 'Selected hy3-x initially visible after reopen')
}
const run=await runner(process.argv.slice(2))
try {
  await Promise.all([320,390,1280].flatMap(w=>['light','dark'].map(t=>run.visit(w,t,'workbuddy-models',installHunyuanPort,catalog))))
} finally { await run.finish() }
