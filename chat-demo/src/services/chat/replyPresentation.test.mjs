import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Keep these pure presentation tests independent of the browser settings store.
registerHooks({
  resolve(id, context, next) {
    if (id.endsWith('/i18n/index.js')) {
      return {
        url: 'data:text/javascript,export const translate=k=>k;export const isTranslationKey=()=>true',
        shortCircuit: true,
      }
    }
    if (id === './client.js') {
      return {
        url: 'data:text/javascript,export class ApiError extends Error {}',
        shortCircuit: true,
      }
    }
    if (id === '../api/errors.js' || id === '../api/searchCitations.js') {
      return next(id.replace(/\.js$/, '.ts'), context)
    }
    return next(id, context)
  },
})
const { buildReplyView, getAreaTitle } = await import('./view.ts')
const { describeReply } = await import('./describe.ts')
const answer = { type: 'text', text: 'A direct answer.' }
const reply = (blocks, thinking = true) => ({ status: 'done', thinking, blocks })

test('a missing or blank reasoning block does not label a normal answer or create an error, including v53 records', () => {
  for (const thinking of [true, false]) {
    for (const blocks of [
      [answer],
      [{ type: 'thinking', thinking: '  \n ', signature: 'kept' }, answer],
    ]) {
      const previous = { ...reply(blocks, thinking), workBuddyReasoningUnavailable: true }
      const view = buildReplyView(previous, false)
      assert.equal(view.answer.text, answer.text)
      assert.deepEqual(view.steps, [])
      assert.equal(describeReply(previous), null)
    }
  }
})

test('a payment error links back only to the provider that billed this request', () => {
  const error = { status: 'error', blocks: [], error: { kind: 'http', status: 402 } }
  assert.deepEqual(describeReply(error), { text: 'replyProviderBalance' })
  assert.deepEqual(describeReply({ ...error, error: { ...error.error, officialApiBilling: true } }), {
    text: 'replyInsufficientBalance', action: 'topUp',
  })
})

test('real reasoning remains identifiable independently of the final answer', () => {
  const reasoning = {
    type: 'thinking',
    thinking: 'Check the units.',
    startedAt: 1000,
    endedAt: 3000,
  }
  const streaming = buildReplyView(reply([reasoning]), true)
  assert.equal(streaming.steps[0].type, 'thinking')
  const done = buildReplyView(reply([reasoning, answer]), false)
  assert.deepEqual(done.steps[0].blocks, [reasoning])
  assert.equal(getAreaTitle(done, false, 3000), 'messageThinkDurationPlural')
  assert.equal(done.answer.text, answer.text)
  assert.equal(buildReplyView(reply([reasoning, answer], false), false).steps.length, 0)
})

test('a continued answer stays complete in Markdown, copy and read aloud after reasoning resumes', () => {
  const original = { type: 'text', text: 'One and' }
  const resumed = { type: 'thinking', thinking: 'Finish the list.' }
  const suffix = { type: 'text', text: ' two.' }
  const view = buildReplyView(reply([original, resumed, suffix]), false)
  assert.equal(view.answer.text, 'One and two.')
  assert.equal(view.answer.markdown, 'One and two.')
  assert.deepEqual(view.steps.map((step) => step.type), ['thinking'])
})

test('tool-only timeline keeps all attempted pages, including failed opens', () => {
  const blocks = Array.from({ length: 14 }, (_, i) => {
    const url = `https://example.com/page/${i}`
    const id = `open${i}`
    return [
      { type: 'server_tool_use', kind: 'deep_search', id, input: { action: 'open_page', url } },
      {
        type: 'web_fetch_tool_result',
        kind: 'deep_search',
        tool_use_id: id,
        content:
          i === 9
            ? { type: 'web_fetch_tool_result_error', error_code: 'unavailable' }
            : { type: 'web_fetch_result', url, content: { title: `Page ${i}` } },
      },
    ]
  }).flat()
  const view = buildReplyView(reply(blocks), false)
  assert.deepEqual(
    view.steps.map((step) => step.type),
    ['open']
  )
  assert.equal(view.steps[0].pages.length, 14)
  assert.equal(view.steps[0].pages[9].status, 'failed')
  assert.equal(view.steps[0].pages.at(-1).title, 'Page 13')
})
