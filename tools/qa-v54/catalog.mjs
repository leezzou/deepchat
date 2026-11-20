import assert from 'node:assert/strict'

// The context catalog is shared. The profile editor is an Android/mobile settings route.
export async function catalog({ page, phone, motion, shot, check, result }, { settings, choose }) {
  await settings(page)
  await page.locator('[data-context-settings-entry]').click()
  const panel = page.locator('[data-context-settings]')
  const provider = panel.getByRole('button', { name: '服务方案', exact: true })
  await provider.focus()
  await provider.press('ArrowDown')
  const providers = page.getByRole('listbox').last()
  const choices = await providers.getByRole('option').allTextContents()
  check(
    choices.length === 38 && new Set(choices).size === 38,
    'Provider menu exposes account channels and all provider presets'
  )
  await providers.getByRole('option', { name: /OpenCode Zen/ }).click()
  await page.locator('[role="listbox"][aria-label="服务方案"]').waitFor({ state: 'detached' })
  const browse = panel.getByTestId('model-picker-browse')
  await browse.focus()
  await browse.press('Enter')
  const filter = page.getByTestId('model-picker-search')
  await filter.fill('big-pickle')
  const item = page.locator('button[data-model-id="big-pickle"]')
  await item.waitFor()
  await item.focus()
  await item.press('Enter')
  const field = panel.locator('[data-context-window]')
  const source = panel.locator('a[href^="https://opencode.ai/"]')
  await source.first().waitFor()
  const value = await field.inputValue()
  check(value === '200000', 'OpenCode Zen Big Pickle exposes sourced 200,000-token default')
  check(
    (await panel.innerText()).includes('160,000'),
    'Catalog lists the 160,000-token input cap separately'
  )
  check(
    (await panel.innerText()).includes('32,000'),
    'Catalog shows the 32,000-token maximum output separately'
  )
  await field.fill('150000')
  await panel.locator('[data-context-save]').click()
  await panel.getByText('已保存。', { exact: true }).waitFor()
  await shot('sourced-window')
  await choose(page, panel, '服务方案', 'OpenAI')
  await panel.getByTestId('model-picker-browse').click()
  await filter.fill('gpt-4.1-mini')
  await page.locator('[data-model-id="gpt-4.1-mini"]').click()
  check(
    (await field.inputValue()) === '1047576',
    'OpenAI non-default model uses its own catalog window'
  )
  await choose(page, panel, '服务方案', /OpenCode Zen/)
  await panel.getByTestId('model-picker-browse').click()
  await filter.fill('big-pickle')
  await item.click()
  check(
    (await field.inputValue()) === '150000',
    'Provider switch keeps only the edited model override'
  )
  await panel.locator('[data-context-reset]').click()
  await panel.getByText('已恢复默认值。', { exact: true }).waitFor()
  check((await field.inputValue()) === value, 'Reset restores the exact sourced catalog window')
  const sourceUrl = await source.first().getAttribute('href')
  check(
    sourceUrl === 'https://opencode.ai/inference/openai/v1/models',
    'Window attribution links to this model’s published provider endpoint'
  )
  await choose(page, panel, '服务方案', '讯飞星火')
  await browse.click()
  await filter.fill('generalv3')
  await page.locator('[data-model-id="generalv3"]').click()
  check(
    (await field.inputValue()) === '8192' && /输入上限/.test(await panel.innerText()),
    'Spark Pro uses its published 8,192 input limit when total context is unknown'
  )
  if (!phone && motion === 'reduce') {
    const visited = {}
    for (const label of choices.slice(2)) {
      await choose(page, panel, '服务方案', label)
      await browse.click()
      const items = panel.locator('button[data-model-id]')
      await items.first().waitFor()
      const ids = await items.evaluateAll((rows) => rows.map((row) => row.dataset.modelId))
      assert.ok(ids.length && new Set(ids).size === ids.length, label)
      visited[label] = { first: ids[0], visibleRows: ids.length }
      await browse.click()
    }
    result.catalogSweep = visited
    check(
      Object.keys(visited).length === 36,
      'All 34 remote catalogs and two local references expose selectable model IDs'
    )
  }
  result.catalog = {
    providerEntries: choices.length,
    model: 'big-pickle',
    source: sourceUrl,
    default: Number(value),
  }
}

export async function discovery({ page, shot, check, result }, { settings, choose, eventually }) {
  const endpointA = 'https://api.openai.com/v1/models',
    endpointB = 'https://api.groq.com/openai/v1/models'
  const keyA = 'qa54-synthetic-a',
    keyB = 'qa54-synthetic-b',
    keyFailure = 'qa54-synthetic-error'
  const sent = [],
    late = []
  let release,
    mode = 'ok'
  const gate = new Promise((done) => {
    release = done
  })
  // Registered on the page, above the context's network block. Fulfill every model request locally.
  await page.route('**/models', async (route) => {
    const url = route.request().url(),
      auth = route.request().headers().authorization
    if (![endpointA, endpointB].includes(url)) return route.abort()
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Authorization',
        },
      })
    sent.push({
      url,
      keyClass:
        auth === `Bearer ${keyA}`
          ? 'A'
          : auth === `Bearer ${keyB}`
            ? 'B'
            : auth === `Bearer ${keyFailure}`
              ? 'failure'
              : 'unrecognized',
    })
    if (url === endpointA) await gate
    const data =
      url === endpointA
        ? [{ id: 'qa-openai-only' }]
        : [{ id: 'qa-groq-only', context_length: 98000 }]
    await route
      .fulfill({
        status: mode === 'fail' ? 503 : 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        json: mode === 'fail' ? { error: 'test outage' } : { data },
      })
      .catch((e) => late.push(e.message.split('\n')[0]))
  })
  async function form() {
    await settings(page)
    await page.getByRole('button', { name: /API Key 管理/ }).click()
    await page.getByRole('button', { name: '添加 API Key', exact: true }).click()
  }
  try {
    await form()
    const scope = page.locator('[data-settings-route][data-route-position="front"]').last()
    const key = page.locator('#api-profile-key'),
      model = page.locator('#api-profile-model')
    await choose(page, scope, '服务商', 'OpenAI')
    await key.fill(keyA)
    await eventually(() => sent.some((x) => x.url === endpointA), 'automatic OpenAI discovery')
    await choose(page, scope, '服务商', 'Groq')
    check((await key.inputValue()) === '', 'Changing provider clears previous origin’s key')
    await key.fill(keyB)
    await eventually(() => sent.some((x) => x.url === endpointB), 'automatic Groq discovery')
    release()
    await page.getByTestId('model-picker-browse').click()
    const filter = page.getByTestId('model-picker-search')
    await filter.fill('qa-')
    await page.locator('[data-model-id="qa-groq-only"]').waitFor()
    check(
      (await page.locator('[data-model-id="qa-openai-only"]').count()) === 0,
      'Delayed previous provider response cannot replace current list'
    )
    await page.locator('[data-model-id="qa-groq-only"]').click()
    check((await model.inputValue()) === 'qa-groq-only', 'Discovered deployment can be selected')
    mode = 'fail'
    await model.fill('manual-deployment-54')
    await key.fill(keyFailure)
    await eventually(() => sent.some((x) => x.keyClass === 'failure'), 'failed automatic discovery')
    await page
      .getByText(/(?:获取|载入|加载|发现).*失败|无法(?:获取|发现|载入|连接)/)
      .last()
      .waitFor()
    check(
      (await model.inputValue()) === 'manual-deployment-54',
      'Failed discovery preserves manually entered deployment'
    )
    await shot('manual-after-failure')
    assert.ok(
      sent.every((x) =>
        x.url === endpointA ? x.keyClass === 'A' : ['B', 'failure'].includes(x.keyClass)
      ),
      'Credential crossed provider boundary'
    )
    result.discovery = { requests: sent, lateCancelled: late.length, refreshClicks: 0 }
    check(
      true,
      'All observed discovery calls used only their own provider’s key with zero refresh clicks'
    )
  } finally {
    release()
  }
}
