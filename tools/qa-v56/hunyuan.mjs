// node tools/qa-v56/hunyuan.mjs <APK assets/public> <fresh evidence directory> [--baseline-v55]
import assert from 'node:assert/strict'
import { runner, button, openSettings } from './browser.mjs'
import { installHunyuanPort } from './hunyuan-fixture.mjs'

const [assets, out, mode] = process.argv.slice(2)
assert.ok(!mode || mode === '--baseline-v55')
const baseline = mode === '--baseline-v55'
const run = await runner([assets, out])
assert.ok(run.report.version === (baseline ? '1.0.55' : '1.0.56') || (!baseline && run.report.version === '1.0.57'))
const scenarios = [
  { label: 'hy3-label', id: 'hy3', returned: 'Hy3' },
  { label: 'hy3-snapshot', id: 'hy3', returned: 'hy3-202608' },
  { label: 'ambiguous-hy3-label', id: 'hy3-x', returned: 'Hy3', reject: true },
  { label: 'hy4-preview-sibling', id: 'hy4-preview-x', returned: 'hy4-preview', reject: true },
  { label: 'hy4-preview-planner', id: 'hy4-preview', returned: 'Hy4 preview', planner: true },
  { label: 'hy4-flash-label', id: 'hy4-flash', returned: 'Hy4 flash' },
  { label: 'hy4-release-label', id: 'hy4', returned: 'Hy4' },
  { label: 'hy4std-label', id: 'hy4std', returned: 'hy4' },
  { label: 'hy4flash-label', id: 'hy4flash', returned: 'hy4-flash' },
  { label: 'hy4flash-free-label', id: 'hy4flash-free', returned: 'hy4-flash-free' },
  { label: 'turbos', id: 'hunyuan-chat', returned: 'Hunyuan-Turbos' },
  { label: 'direct-hy3', id: 'hy3', returned: 'hy3' },
  { label: 'direct-glm', id: 'glm-5.3', returned: 'glm-5.3' },
  { label: 'direct-kimi', id: 'kimi-k3-2', returned: 'kimi-k3-2' },
  { label: 'direct-paid-hy3', id: 'hy3-x', returned: 'hy3-x' },
  { label: 'declared-origin', id: 'hy3-x', origin: 'hy-deploy-qa', returned: 'hy-deploy-qa' },
  { label: 'undeclared-origin', id: 'hy3-x', returned: 'hy-deploy-qa', reject: true },
  { label: 'blank-then-exact', id: 'hy3-x', returned: '', then: 'hy3-x' },
  { label: 'vendor-denial', id: 'hy3', returned: 'other', serviceError: true },
  { label: 'object-valued-model', id: 'hy3', returned: { id: 'hy3' }, reject: true },
  { label: 'unknown-hy3-snapshot', id: 'hy3', returned: 'hy3-209909', reject: true },
  { label: 'different-generation', id: 'hy3-x', returned: 'hy4-preview', reject: true },
  { label: 'variant-not-base', id: 'hy4-preview', returned: 'hy4-flash', reject: true },
  { label: 'wrong-planner', id: 'hy3-x', returned: 'glm-5.3', planner: true, reject: true },
  { label: 'wrong-provider', id: 'deepseek-v4-pro', returned: 'hy3', reject: true },
  { label: 'late-change', id: 'hy3-x', returned: 'hy3-x', late: 'glm-5.3', reject: true },
]

const revision = '00000000-0000-4000-8000-000000000056'
const answer = '流式回复已完成。'
function response(scenario, planner) {
  const fields = { id: 'fixture-completion-id', object: 'chat.completion.chunk', created: 1788292800,
    model: scenario.returned }
  if (scenario.serviceError) return [{ ...fields, error: { code: 6004, message: '本模型已达到限额' } }, '[DONE]']
  const choice = (delta, finish_reason = null) => ({ ...fields, model: scenario.then ?? fields.model, choices: [{ index: 0, delta, finish_reason }] })
  return [
    { ...choice({ role: 'assistant', content: '' }), model: scenario.returned },
    ...(planner ? [] : [choice({ reasoning_content: '先读取测试输入。' })]),
    choice({ content: planner ? '{"queries":[],"subjects":[],"read":false,"multi":false}' : answer }),
    choice({}, 'stop'),
    { ...fields, model: scenario.late ?? fields.model, choices: [],
      usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24 } },
    '[DONE]',
  ]
}

async function selectModel(page, id) {
  if (!baseline) {
    await page.locator('[data-model-menu-trigger]').click()
    const menu = page.locator('[data-quick-model-menu]')
    await menu.locator(`[data-model-id="${id}"]`).click()
    await menu.waitFor({ state: 'hidden' })
    return
  }
  await page.getByRole('button', { name: /会话模型与模板/ }).first().click()
  const panel = page.getByRole('dialog', { name: '会话模型与模板' })
  await button(panel, '模型').click()
  const list = page.getByRole('listbox', { name: '模型', exact: true })
  await list.locator(`[data-option-value="${id}"]`).click()
  await button(panel, '应用到会话').click()
  await panel.waitFor({ state: 'detached' })
}

async function deliver(page, scenario, planner, record) {
  const handle = await page.waitForFunction(planning => window.hunyuanFixture.calls.find(c =>
    c.op === 'chat' && !c.max_tokens && (c.purpose === 'search_plan') === planning), planner)
  const request = await handle.jsonValue()
  assert.equal(request.model, scenario.id)
  assert.equal(request.revision, revision)
  const type = planner ? 'search-plan' : 'chat'
  record.checks.push(`${type} uses catalog route ${request.model} and expected account revision`)
  await page.evaluate(({ id, events, origin }) => window.hunyuanFixture.respond(id, events, origin), {
    id: request.id, events: response(scenario, planner), origin: scenario.origin,
  })
}

try {
  for (const scenario of scenarios) {
    await run.visit(390, 'light', scenario.label, installHunyuanPort, async ({ page, shot, record }) => {
      record.fixture = scenario
      await selectModel(page, scenario.id)
      if (scenario.planner) await button(page, '智能搜索').click()
      const question = scenario.planner ? '对比两种步道并核对原文。' : '说一句话。'
      await page.locator('textarea:visible').first().fill(question)
      await button(page, '发送').click()
      const shouldReject = Boolean(scenario.reject || scenario.serviceError || (baseline && scenario.returned !== scenario.id))
      const expectedError = scenario.serviceError && !baseline ? /6004.*本模型已达到限额/ : /Model mismatch/i
      if (scenario.planner) await deliver(page, scenario, true, record)
      if (!scenario.planner || !shouldReject) await deliver(page, scenario, false, record)
      const row = page.locator('[data-message-id]').last()
      if (shouldReject) await row.getByText(expectedError).waitFor()
      else {
        await row.getByText(answer, { exact: true }).waitFor()
        await row.locator('[data-message-actions]').waitFor()
        assert.doesNotMatch(await row.innerText(), /Model mismatch/i)
      }
      const purpose = shouldReject && scenario.planner ? 'search-plan' : 'chat'
      // The app can retain a partial answer when the final usage-only frame changes model.
      // Check the actual ledger terminal state to distinguish that case from a successful send.
      const data = await page.waitForFunction(async ({ id, purpose }) => {
        const rows = await window.hunyuanFixture.receipts()
        const target = rows.filter(r => r.purpose === purpose && r.model === id && r.status !== 'pending')
        return target.length ? rows.filter(r => ['chat', 'search-plan'].includes(r.purpose)) : false
      }, { id: scenario.id, purpose })
      record.receipts = (await data.jsonValue()).map(({ provider, model, responseModel, purpose, status, input, output }) =>
        ({ provider, model, responseModel, purpose, status, input, output }))
      const expectedPurposes = scenario.planner && !shouldReject ? ['chat', 'search-plan'] : [purpose]
      assert.deepEqual(record.receipts.map(r => r.purpose).sort(), expectedPurposes)
      for (const receipt of record.receipts) {
        assert.equal(receipt.provider, 'WorkBuddy')
        assert.equal(receipt.model, scenario.id)
        if (!shouldReject) {
          assert.equal(receipt.status, 'done')
          assert.equal(receipt.input, 17)
          assert.equal(receipt.output, 7)
          const replyModel = scenario.then || scenario.returned
          assert.equal(receipt.responseModel, replyModel === scenario.id ? undefined : replyModel)
        } else assert.ok(['failed', 'interrupted'].includes(receipt.status))
      }
      const calls = await page.evaluate(() => window.hunyuanFixture.calls.filter(c => c.op === 'chat' && !c.max_tokens)
        .map(({ model, purpose }) => ({ model, purpose: purpose || 'chat' })))
      assert.equal(calls.length, scenario.planner && !shouldReject ? 2 : 1)
      assert.ok(calls.every(c => c.model === scenario.id))
      record.calls = calls
      record.visibleOutcome = shouldReject ? (scenario.serviceError && !baseline ? '6004 本模型已达到限额' : 'Model mismatch') : answer
      record.checks.push(shouldReject ? 'expected error shown with a single request' : 'completed answer and counted usage',
        'local receipt attributed to selected WorkBuddy deployment')
      if (['hy3-label', 'wrong-planner'].includes(scenario.label)) await shot('outcome')
      if (!baseline && scenario.label === 'hy3-snapshot') {
        await openSettings(page)
        await page.locator('[data-usage-home-entry]').click()
        const report = page.getByRole('dialog', { name: '模型用量' })
        await report.locator('[data-usage-requests] > summary').click()
        const receipt = report.locator('[data-usage-row][data-model="hy3"][data-purpose="chat"][data-status="done"]')
        await receipt.getByText('服务端返回的模型 · hy3-202608', { exact: true }).waitFor()
        await receipt.scrollIntoViewIfNeeded()
        record.checks.push('usage screen shows selected hy3 and service-reported hy3-202608')
        await shot('usage-details')
      }
    })
  }
} finally { await run.finish() }
