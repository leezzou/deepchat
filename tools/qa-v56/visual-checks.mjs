import assert from 'node:assert/strict'

// Measure the rendered normal-sized label against its actual opaque button fill.
export async function contrast(button, record) {
  const swatch = await button.evaluate((el) => {
    const css = getComputedStyle(el)
    return { ink: css.color, fill: css.backgroundColor, size: css.fontSize }
  })
  const luminance = (rgb) => {
    const values = rgb.match(/[\d.]+/g).map(Number)
    assert.ok(values.length === 3 || values[3] === 1, `Opaque colors required: ${rgb}`)
    return values
      .slice(0, 3)
      .map((v) => v / 255)
      .map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
  }
  const a = luminance(swatch.ink),
    b = luminance(swatch.fill)
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  record.wbSignInContrast = { ...swatch, ratio }
  assert.ok(
    ratio >= 4.5,
    `WorkBuddy sign-in text contrast ${ratio.toFixed(2)}:1, expected at least 4.5:1`
  )
}

export async function composerGeometry(trigger) {
  const geometry = await trigger.evaluate((el) => {
    const row = el.closest('[class*="functionRow"]')
    const controls = [...row.querySelectorAll('button')].filter(
      (node) => node.getClientRects().length
    )
    const rects = controls.map((node) => {
      const r = node.getBoundingClientRect()
      return {
        text: node.getAttribute('aria-label') || node.textContent.trim(),
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      }
    })
    const collisions = []
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i],
          b = rects[j]
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (w > 1 && h > 1) collisions.push([a.text, b.text, Math.round(w), Math.round(h)])
      }
    const labels = [...el.querySelectorAll('span')].filter(
      (node) => node.clientWidth > 0 && node.textContent.trim()
    )
    return {
      rects,
      collisions,
      labels: labels.map((node) => ({
        text: node.textContent.trim(),
        fits: node.scrollWidth <= node.clientWidth + 1,
      })),
    }
  })
  assert.deepEqual(geometry.collisions, [], 'Closed composer contains overlapping action targets')
  assert.ok(
    geometry.labels.some((label) => /Flash|Pro/i.test(label.text) && label.fits),
    `Current Flash/Pro variant must be readable: ${JSON.stringify(geometry.labels)}`
  )
  return geometry
}
