// Synthetic native boundary only. The browser renders and mutates real application state.
export function accountsFixture() {
  const makePhoto = (color) => `https://avatars.qa.example/__v56_qa__/${color.slice(1)}.svg`
  const profiles = {
    d1: {
      name: '青柠 QA',
      revision: '00000000-0000-4000-8000-000000000561',
      avatar: makePhoto('#117948'),
    },
    d2: {
      name: '紫苏 QA',
      revision: '00000000-0000-4000-8000-000000000562',
      avatar: makePhoto('#704aaa'),
    },
    w1: {
      name: '墨竹 QA',
      revision: '00000000-0000-4000-8000-000000000563',
      avatar: makePhoto('#2275ac'),
    },
    w2: { name: '叶舟 QA', revision: '00000000-0000-4000-8000-000000000564', avatar: null },
  }
  const state = JSON.parse(sessionStorage.getItem('v56-fixture-accounts') || '{"d":null,"w":null}')
  const save = () => sessionStorage.setItem('v56-fixture-accounts', JSON.stringify(state))
  const calls = []
  const deliver = (port, frame) =>
    queueMicrotask(() => port.onmessage?.({ data: JSON.stringify(frame) }))
  const dsh = () =>
    deliver(window.DshNative, { type: 'account', signedIn: !!state.d, ...profiles[state.d] })
  const wb = (id) =>
    deliver(window.WorkBuddyChat, {
      type: 'status',
      id,
      ...(state.w && {
        ...profiles[state.w],
        model: 'deepseek-v4.1-flash',
        catalog: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek', contextWindow: 1000000, reasoning: true },
        ],
        catalogUpdatedAt: Date.now(),
      }),
    })
  window.DshNative = {
    postMessage(raw) {
      const c = JSON.parse(raw)
      calls.push('dsh:' + c.op)
      if (c.op === 'status') dsh()
      if (c.op === 'confirmAccountLogout') {
        state.d = null
        save()
        dsh()
      }
    },
  }
  window.WorkBuddyChat = {
    postMessage(raw) {
      const c = JSON.parse(raw)
      calls.push('wb:' + c.op)
      if (c.op === 'forget') {
        state.w = null
        save()
      }
      wb(c.id)
    },
  }
  window.AndroidUpdater = {
    getInstalledVersion: () => document.querySelector('meta[name="application-version"]').content,
  }
  window.v56QA = {
    profiles,
    state,
    calls,
    update(d, w) {
      state.d = d
      state.w = w
      save()
      dsh()
      document.dispatchEvent(new Event('visibilitychange'))
    },
  }
}
