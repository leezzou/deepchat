// No credentials, remote speech services or microphones needed. Run with node --test.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { experiments } from '@rspack/core'

registerHooks({
  resolve(id, ctx, next) {
    if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL) {
      const typed = new URL(id.slice(0, -3) + '.ts', ctx.parentURL)
      if (existsSync(typed)) return next(typed.href, ctx)
    }
    return next(id, ctx)
  },
  load(url, ctx, next) {
    if (!url.endsWith('.ts')) return next(url, ctx)
    // Keep the real speech/route stores and simulate only chat lifecycle notifications.
    if (url.endsWith('/chat/store.ts')) return { format: 'module', shortCircuit: true,
      source: `import {create} from 'zustand'; export const useChatStore=create(()=>({activeId:null,streaming:{},sessionCache:{}}))` }
    const filename = fileURLToPath(url)
    const { code: source } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
      filename, jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'es6' },
    })
    return { source, format: 'module', shortCircuit: true }
  },
})
const window = globalThis.window = new EventTarget()
const document = globalThis.document = new EventTarget()
document.hidden = false
const storage = new Map()
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
const { transcribe, synthesize } = await import('../api/speech.ts')
const { useSettings } = await import('../settings.ts')
const { useWorkBuddyState } = await import('../workbuddy/provider.ts')
const { observeDeviceVoice, useDeviceVoice, speakLocally, webLocalVoice, recognizeLocally, voiceChunks, MAX_READ_CHARS } = await import('./deviceVoice.ts')
const { toggleReadAloud, useReadAloud, stopReadAloud } = await import('./readAloud.ts')
const { speechMode } = await import('./speechRoute.ts')
const { bindAutoRead } = await import('./autoRead.ts')
const { useChatStore } = await import('../chat/store.ts')
const tick = () => new Promise(resolve => setImmediate(resolve))
const api = (origin, protocol) => ({ source: 'api', key: 'dummy', config: { origin, protocol, model: 'deepseek-v4-pro' } })
const wav = new Blob(['wave'], { type: 'audio/wav' })
const controller = () => new AbortController()
const profile = { id: 'provider-A', name: 'compatible', origin: 'https://fixture.invalid/v1', protocol: 'openai', model: 'deepseek-v4-pro', apiKey: 'dummy' }
function select(origin = profile.origin) {
  useSettings.setState({ locale: 'en-US', chatSource: 'api', activeProfileId: profile.id, apiProfiles: [{ ...profile, origin }] })
}
function installVoices(voices) {
  const spoken = []
  const synth = window.speechSynthesis = Object.assign(new EventTarget(), {
    getVoices: () => voices, speak: utterance => { spoken.push(utterance); utterance.onstart?.() },
    cancelled: 0, cancel: () => synth.cancelled++,
  })
  return { synth, spoken }
}
const localEn = { localService: true, lang: 'en-US' }, remoteEn = { localService: false, lang: 'en-US' }

test('official root and v1 in both protocols issue exactly one request to the selected service, with its key', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
    assert.equal(init.headers.Authorization, 'Bearer dummy')
    if (url.endsWith('/asr')) {
      assert.equal(url, 'https://api.deepseek.com/v1/tools/asr'); assert.equal(init.body.get('file').size, wav.size)
      return Response.json({ text: 'hello' })
    }
    assert.equal(url, 'https://api.deepseek.com/v1/tools/tts'); assert.equal(JSON.parse(init.body).text, 'hello')
    return new Response(new Uint8Array([0,2]))
  })
  for (const origin of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/']) for (const protocol of ['openai', 'deepseek']) {
    assert.equal(await transcribe(api(origin, protocol), wav, controller().signal), 'hello')
    await (await synthesize(api(origin, protocol), 'hello', 'stella', controller().signal)).cancel()
  }
  assert.equal(fetch.mock.callCount(), 8)
})

test('speech dispatch fails closed on WorkBuddy, proxies, unrecognized paths, userinfo and lookalikes', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('data left device'))
  const origins = ['https://fixture.invalid/v1', 'http://api.deepseek.com', 'https://api.deepseek.com/other', 'https://api.deepseek.com/v1?x',
    'https://user@api.deepseek.com', 'https://api.deepseek.com:8443/v1', 'https://api.deepseek.com.invalid', '/proxy']
  for (const access of [{ source: 'workbuddy' }, ...origins.flatMap(o => ['openai','deepseek'].map(p => api(o,p)))]) {
    await assert.rejects(transcribe(access, wav)); await assert.rejects(synthesize(access, 'private', 'tide', controller().signal))
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('local speech refuses cloud-only and wrong-language voices, reacts to installed voices, and cancels per chunk', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('data left device'))
  const voices = [remoteEn, { lang: 'fr-FR', localService: true }]
  const { synth, spoken } = installVoices(voices)
  const unobserve = observeDeviceVoice('en-US')
  try {
    assert.equal(useDeviceVoice.getState().tts, false)
    await assert.rejects(speakLocally('private', 'en-US', controller().signal, () => {}))
    voices.push(localEn); synth.dispatchEvent(new Event('voiceschanged'))
    assert.equal(useDeviceVoice.getState().tts, true); assert.equal(webLocalVoice('zh-CN'), undefined)
    const op = controller()
    const done = speakLocally('Voice. '.repeat(160), 'en-US', op.signal, () => {})
    assert.equal(spoken.length, 1); assert.equal(spoken[0].voice, localEn)
    spoken[0].onend(); await tick(); assert.equal(spoken.length, 2)
    op.abort(); await assert.rejects(done)
    assert.equal(synth.cancelled, 1); assert.equal(fetch.mock.callCount(), 0)
    const sentence = 'a'.repeat(239) + '🙂' + '汉'.repeat(900)
    const pieces = [...voiceChunks(sentence)]
    assert.ok(pieces.every(text => text.isWellFormed() && text.length <= 240)); assert.equal(pieces.join(''), sentence)
    await assert.rejects(speakLocally('a'.repeat(MAX_READ_CHARS + 1), 'en-US', controller().signal, () => {}), /too-long/)
  } finally { unobserve() }
})

test('only explicit locally processed installed dictation can start, with cancellation before and after probing', async () => {
  let started = 0, aborted = 0, installed = false
  class Recognition {
    static async available(options) {
      assert.deepEqual(options, { langs: ['en-US'], processLocally: true })
      return installed ? 'available' : 'downloadable'
    }
    get processLocally() { return this.local }; set processLocally(value) { this.local = value }
    start() { assert.equal(this.local, true); ++started }
    abort() { ++aborted; this.onend?.() }; stop() { this.onresult?.({ results: [[{ transcript: 'local text' }]] }) }
  }
  window.SpeechRecognition = Recognition
  try {
    await assert.rejects(recognizeLocally('en-US').result); assert.equal(started, 0)
    installed = true
    let operation = recognizeLocally('en-US'); operation.cancel(); await assert.rejects(operation.result); assert.equal(started, 0)
    operation = recognizeLocally('en-US'); await tick(); operation.finish(); assert.equal(await operation.result, 'local text')
    operation = recognizeLocally('en-US'); await tick(); operation.cancel(); await operation.result.catch(() => {})
    assert.equal(aborted, 1); assert.equal(started, 2)
    window.SpeechRecognition = class { start() { assert.fail('ordinary online recognizer started') } }
    await assert.rejects(recognizeLocally('en-US').result)
  } finally { delete window.SpeechRecognition }
})

test('same model on compatible and WorkBuddy uses local voice, provider/language switch and page hiding stop it', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('data left device'))
  select()
  const { spoken } = installVoices([remoteEn, localEn]); const stopProbe = observeDeviceVoice('en-US')
  const errors = []
  try {
    toggleReadAloud('1', 'private', e => errors.push(e), 'chat'); assert.equal(useReadAloud.getState().status, 'playing')
    useWorkBuddyState.setState({ metadata: { revision: 'abcd', model: 'deepseek-v4-pro' } }); useSettings.setState({ chatSource: 'workbuddy' })
    assert.equal(useReadAloud.getState().status, 'idle'); assert.equal(speechMode('chat','tts'), 'device')
    toggleReadAloud('2', 'private', e => errors.push(e), 'chat'); useSettings.setState({ locale: 'zh-CN' })
    assert.equal(useReadAloud.getState().status, 'idle'); assert.equal(speechMode('chat','tts'), 'unavailable')
    useSettings.setState({ locale: 'en-US' }); toggleReadAloud('3', 'private', e => errors.push(e), 'chat')
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); document.hidden = false
    assert.equal(useReadAloud.getState().status, 'idle'); assert.equal(spoken.length, 3)
    assert.equal(fetch.mock.callCount(), 0); assert.deepEqual(errors, [])
  } finally { stopProbe(); stopReadAloud() }
})

test('automatic speech consumes just the completed foreground answer, skips restore, refusal, other destinations and stops', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('data left device'))
  select(); useSettings.setState({ autoRead: true }); const { spoken } = installVoices([localEn]); const stopProbe = observeDeviceVoice('en-US')
  const unbind = bindAutoRead(e => assert.fail(e)); const sessionId = 's'
  function state(status, streaming, stopReason = 'end_turn') {
    const messages = [{ id: 'm', role: 'assistant', status, stopReason, blocks: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Only answer' }] }]
    useChatStore.setState({ activeId: sessionId, sessionCache: { [sessionId]: { messages } }, streaming: streaming ? { [sessionId]: controller() } : {} })
  }
  try {
    state('done', false); assert.equal(spoken.length, 0)
    state('streaming', true); state('done', false); assert.deepEqual(spoken.map(u => u.text), ['Only answer'])
    spoken[0].onend(); await tick()
    state('streaming', true); state('stopped', false)
    state('streaming', true); state('done', false, 'refusal')
    state('streaming', true); select('https://api.deepseek.com'); state('done', false)
    select(); state('streaming', true); useChatStore.setState({ activeId: 'other' }); state('done', false)
    useSettings.setState({ autoRead: false }); state('streaming', true); state('done', false)
    assert.equal(spoken.length, 1); assert.equal(fetch.mock.callCount(), 0)
  } finally { unbind(); stopProbe(); stopReadAloud() }
})
