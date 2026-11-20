// Acceptance QA for v1.0.56: location entry removal + conversation model picker removal.
// Normal UI entry only; no app state or DOM patching beyond locale seeding for the English smoke.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { button, openSettings, runner } from '../qa-v56/browser.mjs'
import { composerGeometry } from '../qa-v56/visual-checks.mjs'

const run = await runner(process.argv.slice(2))
const LOCATION = /位置信息|Location/u

const copy = (en) =>
  en
    ? {
        settings: 'Settings',
        conversationSettings: 'Conversation settings',
        provider: 'Provider',
        template: 'Prompt template',
        newTemplate: 'New template',
        editTemplate: 'Edit template',
        templateName: 'Template name',
        instructions: 'Instructions',
        saveTemplate: 'Save template',
        apply: 'Apply',
        model: 'Model',
        noTemplate: 'No template',
        message: 'Message',
        send: 'Send',
        chooseModel: 'Choose model',
      }
    : {
        settings: '设置',
        conversationSettings: '会话设置',
        provider: '服务方案',
        template: '提示词模板',
        newTemplate: '新建模板',
        editTemplate: '编辑模板',
        templateName: '模板名称',
        instructions: '系统提示词',
        saveTemplate: '保存模板',
        apply: '应用到会话',
        model: '模型',
        noTemplate: '不使用模板',
        message: '消息',
        send: '发送',
        chooseModel: '选择模型',
      }

async function innerText(scope) {
  return (await scope.innerText()).replace(/\s+/g, ' ').trim()
}

function note(record, key, value = true) {
  ;(record.audit ??= {})[key] = value
}

async function measure(scope, name, record) {
  const metrics = await scope.evaluate((el) => {
    const all = [el, ...el.querySelectorAll('*')]
    const overflow = all
      .filter((node) => {
        if (!(node instanceof HTMLElement) || node.clientWidth <= 0) return false
        const style = getComputedStyle(node)
        return (
          /^(scroll|auto)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1
        )
      })
      .map((node) => ({
        tag: node.tagName,
        className: String(node.className).slice(0, 80),
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }))
    const rect = el.getBoundingClientRect()
    return {
      viewport: [innerWidth, innerHeight],
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflow,
    }
  })
  ;(record.metrics ??= {})[name] = metrics
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `Horizontal overflow in ${name}: ${JSON.stringify(metrics)}`
  )
  assert.ok(
    metrics.rect.left >= -1 && metrics.rect.right <= metrics.viewport[0] + 1,
    `Element outside viewport in ${name}: ${JSON.stringify(metrics)}`
  )
  return metrics
}

async function expectFocusInside(page, scope, label) {
  await page.waitForFunction(
    (selector) => {
      const root = document.querySelector(selector)
      return !!root && root.contains(document.activeElement)
    },
    label,
    { timeout: 3000 }
  )
}

async function settingsAudit({ page, record, shot, phone }) {
  await openSettings(page)
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.waitFor()
  assert.equal(await page.locator('[data-settings-route="location"]').count(), 0)
  if (phone) {
    const root = page.locator(
      '[data-settings-route="root"][data-route-position="front"]:not([inert])'
    )
    await root.waitFor()
    const text = await innerText(root)
    assert.ok(!LOCATION.test(text), `Location text on mobile root: ${text.slice(0, 500)}`)
    const names = await root.locator('button').evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim())
    )
    assert.ok(
      !names.some((name) => LOCATION.test(name)),
      `Location control name on mobile root: ${names.join(' | ')}`
    )
    // Root + every row must be reachable inside one viewport with no horizontal scroll.
    await measure(root, 'settings-root', record)
    await shot('settings-root')
    note(record, 'settingsNoLocation')
    await button(root, '返回').click()
    await root.waitFor({ state: 'detached' })
    const collapse = page.getByRole('button', { name: '收起边栏', exact: true })
    if (await collapse.isVisible().catch(() => false)) {
      await collapse.click()
      await page.waitForFunction(
        () => {
          const drawer = document.querySelector('[role="dialog"][aria-label="全部对话"]')
          return !!drawer && drawer.getAttribute('aria-hidden') === 'true'
        },
        undefined,
        { timeout: 3000 }
      )
    }
    return
  }
  const panel = page.locator('[data-settings-panel="general"]')
  await panel.waitFor()
  const generalText = await innerText(panel)
  assert.ok(!LOCATION.test(generalText), `Location text in desktop general settings: ${generalText}`)
  const tabs = page.getByRole('tab')
  const tabLabels = await tabs.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()))
  assert.ok(
    !tabLabels.some((label) => LOCATION.test(label)),
    `Location tab in desktop navigation: ${tabLabels.join(' | ')}`
  )
  // No other desktop section may expose a location row either.
  const count = await tabs.count()
  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index)
    const label = (await tab.innerText()).trim()
    await tab.click()
    const text = await innerText(dialog)
    assert.ok(!LOCATION.test(text), `Location content on desktop tab ${label}: ${text.slice(0, 400)}`)
  }
  record.checks.push(`Location absent on all ${count} desktop tabs`)
  await page.locator('[data-settings-tab="general"]').click()
  await panel.waitFor()
  await measure(dialog, 'settings-desktop', record)
  await shot('settings-general')
  note(record, 'settingsNoLocation')
  assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)), 'Settings focus escaped')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
}

async function conversationAudit({ page, record, shot, phone, en }) {
  const t = copy(en)
  const trigger = page.locator('button.conversation-mode-trigger:visible').first()
  await trigger.waitFor()
  const triggerLabel = await trigger.getAttribute('aria-label')
  assert.ok(
    triggerLabel?.includes(t.conversationSettings),
    `Conversation trigger aria-label should contain ${t.conversationSettings}, got ${triggerLabel}`
  )
  const triggerText = await innerText(trigger)
  if (!phone) {
    assert.ok(
      triggerText.includes(t.conversationSettings),
      `Conversation trigger visible title should be ${t.conversationSettings}, got ${triggerText}`
    )
  } else {
    // The mobile header stacks the chat title (heading) above a caption that CSS hides; the
    // accessible name still carries the 会话设置 title and the opened dialog title is asserted below.
    assert.ok(triggerText.length > 0, 'Conversation trigger has no visible heading')
  }
  note(record, 'conversationTitle', { ariaLabel: triggerLabel, text: triggerText })

  await trigger.click()
  const panel = page.getByRole('dialog', { name: t.conversationSettings, exact: true })
  await panel.waitFor()
  assert.ok(await panel.evaluate((el) => el.contains(document.activeElement)), 'Panel focus escaped')
  const rowLabels = await panel.locator('.conversation-mode-row > span').allInnerTexts()
  assert.deepEqual(
    rowLabels.map((label) => label.trim()),
    [t.provider, t.template],
    `Conversation rows changed: ${JSON.stringify(rowLabels)}`
  )
  const selectLabels = await panel
    .locator('button[aria-haspopup]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
  assert.deepEqual(
    selectLabels.sort(),
    [t.provider, t.template].sort(),
    `Conversation select controls changed: ${JSON.stringify(selectLabels)}`
  )
  assert.equal(await panel.locator('.conversation-mode-model').count(), 0, 'Model picker row remains')
  assert.equal(
    await panel.getByRole('button', { name: t.model, exact: true }).count(),
    0,
    'Model select button remains'
  )
  assert.equal(await panel.getByRole('combobox').count(), 0, 'Combobox model control remains')
  assert.equal(
    await panel.getByRole('button', { name: t.template, exact: true }).count(),
    1,
    'Prompt template select missing'
  )
  await measure(panel, 'conversation-panel', record)
  await shot('conversation-panel')
  note(record, 'noModelControl')
  note(record, 'providerTemplateKept')

  const templateName = `QA 模板 ${record.width}-${record.theme}`
  await button(panel, t.newTemplate).click()
  const editor = page.getByRole('dialog', { name: t.editTemplate, exact: true })
  await editor.waitFor()
  await editor
    .locator('label')
    .filter({ hasText: t.templateName })
    .locator('input')
    .fill(templateName)
  await editor
    .locator('label')
    .filter({ hasText: t.instructions })
    .locator('textarea')
    .fill('请用简洁中文回答。')
  await editor.getByRole('button', { name: t.saveTemplate, exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  await panel.waitFor()

  await button(panel, t.template).click()
  if (phone) {
    const picker = page.getByRole('dialog', { name: t.template, exact: true })
    await picker.waitFor()
    await picker.getByRole('option', { name: templateName, exact: true }).click()
    await picker.waitFor({ state: 'detached' })
  } else {
    const list = page.locator(`[role="listbox"][aria-label="${t.template}"]`)
    await list.waitFor()
    await list.getByRole('option', { name: templateName, exact: true }).click()
    await list.waitFor({ state: 'detached' })
  }
  await panel.waitFor()
  const chosen = await innerText(panel)
  assert.ok(chosen.includes(templateName), `Template not selected: ${chosen}`)
  await button(panel, t.apply).click()
  await panel.waitFor({ state: 'detached' })
  const appliedLabel = await trigger.getAttribute('aria-label')
  assert.ok(
    appliedLabel?.includes(templateName),
    `Template not applied on trigger: ${appliedLabel}`
  )

  await trigger.click()
  const reopened = page.getByRole('dialog', { name: t.conversationSettings, exact: true })
  await reopened.waitFor()
  const reopenedText = await innerText(reopened)
  assert.ok(reopenedText.includes(templateName), `Reopened panel lost template: ${reopenedText}`)
  assert.equal(await reopened.locator('.conversation-mode-model').count(), 0)
  assert.equal(
    await reopened.getByRole('button', { name: t.model, exact: true }).count(),
    0
  )
  await shot('conversation-reopened')
  note(record, 'templateReopen')

  await page.keyboard.press('Escape')
  await reopened.waitFor({ state: 'detached' })
  await page.waitForFunction(
    () => document.activeElement?.classList.contains('conversation-mode-trigger'),
    undefined,
    { timeout: 3000 }
  )
  note(record, 'focusReturned', true)
  return trigger
}

async function modelMenuAudit({ page, record, shot, phone, en }) {
  const t = copy(en)
  const trigger = page.locator('[data-model-menu-trigger]:visible').first()
  await trigger.waitFor()
  await trigger.scrollIntoViewIfNeeded()
  const initial = await trigger.getAttribute('aria-label')
  assert.ok(initial?.includes(t.chooseModel), `Model trigger label missing: ${initial}`)

  if (!phone) {
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    const keyboardMenu = page.locator('[data-quick-model-menu]:visible')
    await keyboardMenu.waitFor()
    await page.waitForFunction(() =>
      document.activeElement?.matches('[data-quick-model-menu] [role="option"][aria-selected="true"]')
    )
    await page.keyboard.press('Escape')
    await keyboardMenu.waitFor({ state: 'detached' })
    assert.ok(
      await trigger.evaluate((el) => el === document.activeElement),
      'Escape did not return focus to ComposerModelMenu trigger'
    )
    record.checks.push('ComposerModelMenu keyboard open/close focus')
  }

  await trigger.click()
  const menu = page.locator('[data-quick-model-menu]:visible')
  await menu.waitFor()
  const selected = menu.locator('[role="option"][aria-selected="true"]')
  assert.equal(await selected.count(), 1, 'Model menu must show one selected row')
  assert.ok((await selected.locator('svg').count()) > 0, 'Selected model row mark missing')
  const geometry = await menu.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return {
      viewport: [innerWidth, innerHeight],
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      },
    }
  })
  assert.ok(
    geometry.rect.left >= -1 &&
      geometry.rect.top >= -1 &&
      geometry.rect.right <= geometry.viewport[0] + 1 &&
      geometry.rect.bottom <= geometry.viewport[1] + 1,
    `ComposerModelMenu clipped: ${JSON.stringify(geometry)}`
  )
  record.modelMenuGeometry = geometry
  await shot('model-menu-open')

  const next = menu.locator('[role="option"][aria-selected="false"]').first()
  const modelId = await next.getAttribute('data-model-id')
  const modelName = (await next.locator('strong').innerText()).trim()
  assert.ok(modelId && modelName)
  await next.click()
  await menu.waitFor({ state: 'detached' })
  const changed = await trigger.getAttribute('aria-label')
  assert.ok(changed?.includes(modelName), `Model switch not reflected: ${changed}`)
  note(record, 'modelMenuSwitch', { from: initial, to: changed, modelId })

  await trigger.click()
  const reopened = page.locator('[data-quick-model-menu]:visible')
  await reopened.waitFor()
  const current = reopened.locator('[role="option"][aria-selected="true"]')
  assert.equal(await current.getAttribute('data-model-id'), modelId)
  await shot('model-menu-changed')
  await page.keyboard.press('Escape')
  await reopened.waitFor({ state: 'detached' })
  await page.waitForFunction(
    () => document.activeElement?.matches('[data-model-menu-trigger]'),
    undefined,
    { timeout: 3000 }
  )

  const text = page.getByRole('textbox', { name: t.message, exact: true })
  await text.fill('模型复核 🧪 模型 QA')
  const send = page.getByRole('button', { name: t.send, exact: true })
  assert.ok(await send.isEnabled(), 'Send disabled after model switch')
  record.composer = await composerGeometry(trigger)
  await shot('composer-draft')
  note(record, 'sendEnabled')
  await text.fill('')
}

async function acceptance({ page, record, shot, phone, en }) {
  await page.locator('textarea:visible').first().waitFor()
  if (!en) await settingsAudit({ page, record, shot, phone })
  else record.checks.push('English smoke: settings audit covered in zh matrix')
  await conversationAudit({ page, record, shot, phone, en })
  await modelMenuAudit({ page, record, shot, phone, en })
  record.checks.unshift('No page errors during full flow')
}

const visits = []
for (const width of [320, 390, 1280]) {
  for (const theme of ['light', 'dark']) {
    visits.push(
      run.visit(width, theme, 'acceptance', undefined, (context) =>
        acceptance({ ...context, en: false })
      )
    )
  }
}
visits.push(
  run.visit(
    1280,
    'light',
    'english',
    () => localStorage.setItem('chat-demo:locale', 'en-US'),
    (context) => acceptance({ ...context, en: true })
  )
)
try {
  await Promise.all(visits)
} finally {
  await run.finish()
}

const failing = run.report.cases.filter((record) => record.failure)
const summary = {
  generatedAt: new Date().toISOString(),
  build: {
    version: run.report.version,
    entry: run.report.entry,
    sha256: run.report.sha256,
    assets: run.report.assets,
    browser: run.report.browser,
  },
  totals: {
    cases: run.report.cases.length,
    passed: run.report.cases.length - failing.length,
    failed: failing.length,
  },
  checklist: {
    'mobile+desktop settings have no Location entry or location route': run.report.cases
      .filter((record) => record.label === 'acceptance')
      .every((record) => record.audit?.settingsNoLocation === true),
    'conversation trigger title is 会话设置': run.report.cases
      .filter((record) => record.label === 'acceptance')
      .every((record) => Boolean(record.audit?.conversationTitle?.ariaLabel?.includes('会话设置'))),
    'conversation panel has no Model control': run.report.cases.every(
      (record) => record.audit?.noModelControl === true
    ),
    'Provider and Prompt template remain': run.report.cases
      .filter((record) => record.label === 'acceptance')
      .every((record) => record.audit?.providerTemplateKept === true),
    'template apply + reopen is error-free': run.report.cases.every(
      (record) => record.audit?.templateReopen === true
    ),
    'ComposerModelMenu opens and switches model': run.report.cases.every(
      (record) => record.audit?.modelMenuSwitch?.modelId
    ),
    'Send stays enabled after model switch': run.report.cases.every(
      (record) => record.audit?.sendEnabled === true
    ),
  },
  cases: run.report.cases.map((record) => ({
    label: record.label,
    width: record.width,
    theme: record.theme,
    pass: !record.failure,
    failure: record.failure,
    checks: record.checks,
    audit: record.audit,
    shots: record.shots,
    metrics: record.metrics,
  })),
}
await writeFile(path.join(run.out, 'report.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary.checklist, null, 2))
