import test from 'node:test'
import assert from 'node:assert/strict'

// WHEN does getUserMedia run? Driven through the real bindChatLiveVoice closure over a fake
// WebSocket (helpers copied from voice-turn-gate-wiring.test.mjs). Born as M4 slice 14's
// wiring of micAttachPlan (ADR-0017 §5.3); ADR-0026 §2 deleted that plan and its deferral, so
// every path now attaches right after the greeting is sent (invariant #25).

const classesOf = (el) => String(el.className || '').split(/\s+/).filter(Boolean)
const hasClass = (el, cls) => classesOf(el).includes(cls)

function firstByClass(root, cls) {
  for (const child of root.children) {
    if (hasClass(child, cls)) return child
    const hit = firstByClass(child, cls)
    if (hit) return hit
  }
  return null
}

// Minimal DOM node: just the surface js/chat-live.js touches on transcript bubbles.
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    parent: null,
    attrs: {},
    setAttribute(name, value) { el.attrs[name] = String(value) },
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null },
    appendChild(child) {
      child.parent = el
      el.children.push(child)
      return child
    },
    remove() {
      const parent = el.parent
      if (!parent) return
      const i = parent.children.indexOf(el)
      if (i >= 0) parent.children.splice(i, 1)
      el.parent = null
    },
    querySelector(selector) { return firstByClass(el, selector.replace(/^\./, '')) }
  }
  el.classList = {
    add(cls) { if (!hasClass(el, cls)) el.className = `${el.className} ${cls}`.trim() },
    remove(cls) { el.className = classesOf(el).filter((c) => c !== cls).join(' ') },
    toggle(cls, on) { if (on) el.classList.add(cls); else el.classList.remove(cls) },
    contains(cls) { return hasClass(el, cls) }
  }
  return el
}

// Records every scheduled PCM chunk — src.start() is the audible effect under test.
function makeAudioContextClass(scheduled) {
  return class FakeAudioContext {
    constructor() {
      this.sampleRate = 24000
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
    }
    async resume() {}
    createBuffer(channels, length, rate) {
      return { duration: length / rate, copyToChannel() {} }
    }
    createBufferSource() {
      return {
        buffer: null,
        onended: null,
        connect() {},
        stop() {},
        start(at) { scheduled.push(at) }
      }
    }
    async close() {}
  }
}

function makeWebSocketClass(sockets) {
  return class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url) {
      this.url = url
      this.readyState = 1
      this.sent = []
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this.onclose = null
      sockets.push(this)
    }
    send(payload) { this.sent.push(payload) }
    close() { this.readyState = 3 }
  }
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

const settle = async (turns = 10) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}


async function bootVoice({ permission }) {
  const sockets = []
  const mic = { calls: 0 }
  const messagesEl = makeEl('ul')
  const micButton = makeEl('button')
  micButton.dataset = {}
  micButton.addEventListener = () => {}
  micButton.removeEventListener = () => {}
  defineGlobal('document', { querySelector: () => null, querySelectorAll: () => [], createElement: (t) => makeEl(t), addEventListener () {} })
  defineGlobal('window', {
    isSecureContext: true,
    location: { protocol: 'http:', hostname: 'portfolio.test', pathname: '/', hash: '', origin: 'http://portfolio.test' },
    matchMedia: () => ({ matches: false, addEventListener () {} }),
    addEventListener () {}
  })
  defineGlobal('navigator', {
    permissions: permission ? { query: async () => ({ state: permission }) } : undefined,
    mediaDevices: {
      getUserMedia: async () => {
        mic.calls += 1
        const err = new Error('harness mic'); err.name = 'NotAllowedError'; throw err
      }
    }
  })
  defineGlobal('AudioContext', makeAudioContextClass([]))
  defineGlobal('WebSocket', makeWebSocketClass(sockets))
  defineGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ websocketUrl: 'wss://chat.test/r', handshake: { setup: {} }, liveVoiceTransport: 'relay' }) }))
  const { bindChatLiveVoice } = await import('../js/chat-live.js?micplan=' + Math.random())
  const live = bindChatLiveVoice({
    messagesEl, statusEl: makeEl('p'), micButtons: [micButton], syncEmptyState () {}, scrollMessagesToBottom () {},
    setStatus () {}, getSessionId: () => 'mic-plan', isTextPending: () => false, openPanel () {}, isPanelOpen: () => true, patchLiveUi () {}
  })
  void live.startVoice({ intent: 'auto' })
  await settle()
  const socket = sockets[0]
  socket.onopen(); await settle()
  socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) }); await settle()
  return { live, mic, send: async (p) => { socket.onmessage({ data: JSON.stringify(p) }); await settle() } }
}

// ADR-0026 §2 (invariant #25) SUPERSEDES slice 14's deferral: on the cold path the greeting
// cannot be talked over unless the mic is already streaming, because Gemini Live's activity
// detection never fires `interrupted` with no upstream audio. The old rows "no mic until the
// greeting finishes" and "hanging up cancels the 15 s fallback" pinned the regression and are
// gone with the machinery they described (test-writer decision, ADR-0026 §2/§7).
// Prompt AND unknown (no Permissions API, e.g. Safari/Firefox): both are the first-visit path.
for (const permission of ['prompt', undefined]) {
  test(`cold path (${permission || 'unknown'}) + greeting: the mic is requested at once, before the greeting's turnComplete`, async () => {
    // Arrange + Act — start voice; the greeting is sent and is still speaking (no turnComplete).
    const v = await bootVoice({ permission })
    try {
      // Assert — no deferral to the greeting's end, nor to any fallback timer.
      assert.equal(
        v.mic.calls, 1,
        'the permission sheet over the speaking greeting is the accepted cost of barge-in (ADR-0026 §2)'
      )
    } finally { v.live.stopVoice?.() }
  })
}

test('granted: the mic attaches at once, as before', async () => {
  const v = await bootVoice({ permission: 'granted' })
  try {
    assert.equal(v.mic.calls, 1)
  } finally { v.live.stopVoice?.() }
})

test('denied: the mic attaches at once so the error surfaces now, not after the greeting', async () => {
  const v = await bootVoice({ permission: 'denied' })
  try {
    assert.equal(v.mic.calls, 1)
  } finally { v.live.stopVoice?.() }
})

// Critic (M4 review): two races the single-trigger tests above could not see.
async function bootControllable () {
  const sockets = []
  const gum = { calls: 0, pending: [] }
  const messagesEl = makeEl('ul')
  const micButton = makeEl('button'); micButton.dataset = {}; micButton.addEventListener = () => {}; micButton.removeEventListener = () => {}
  defineGlobal('document', { querySelector: () => null, querySelectorAll: () => [], createElement: (t) => makeEl(t), addEventListener () {} })
  defineGlobal('window', { isSecureContext: true, location: { protocol: 'http:', hostname: 'portfolio.test', pathname: '/', hash: '', origin: 'http://portfolio.test' }, matchMedia: () => ({ matches: false, addEventListener () {} }), addEventListener () {} })
  defineGlobal('navigator', {
    permissions: { query: async () => ({ state: 'prompt' }) },
    mediaDevices: {
      // The browser's permission prompt: unresolved until the test "clicks Allow".
      getUserMedia: () => { gum.calls += 1; return new Promise((resolve) => gum.pending.push(resolve)) }
    }
  })
  defineGlobal('AudioContext', makeAudioContextClass([]))
  defineGlobal('WebSocket', makeWebSocketClass(sockets))
  defineGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ websocketUrl: 'wss://chat.test/r', handshake: { setup: {} }, liveVoiceTransport: 'relay' }) }))
  const { bindChatLiveVoice } = await import('../js/chat-live.js?race=' + Math.random())
  const live = bindChatLiveVoice({ messagesEl, statusEl: makeEl('p'), micButtons: [micButton], syncEmptyState () {}, scrollMessagesToBottom () {}, setStatus () {}, getSessionId: () => 'race', isTextPending: () => false, openPanel () {}, isPanelOpen: () => true, patchLiveUi () {} })
  void live.startVoice({ intent: 'auto' }); await settle()
  const socket = sockets[0]
  socket.onopen(); await settle()
  socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) }); await settle()
  const fakeStream = () => { const tracks = [{ stopped: false, stop () { this.stopped = true } }]; return { tracks, getTracks: () => tracks } }
  return { live, gum, fakeStream, send: async (p) => { socket.onmessage({ data: JSON.stringify(p) }); await settle() } }
}

test('a mic tap while the at-once attach\'s permission prompt is open joins it: ONE getUserMedia', async () => {
  // Arrange — cold start: the attach went out at once and the browser's prompt is still open.
  const v = await bootControllable()
  try {
    // Act — the visitor taps the mic, then the greeting ends.
    void v.live.attachMicrophone()
    await settle()
    await v.send({ serverContent: { turnComplete: true } })
    // Assert — a second stream would be overwritten and never stopped (mic light on after hang-up).
    assert.equal(v.gum.calls, 1, 'every trigger shares the one in-flight attach')
  } finally { v.live.stopVoice?.() }
})

test('hanging up while the permission prompt is open stops the stream the visitor then allows', async () => {
  const v = await bootControllable()
  void v.live.attachMicrophone()
  await settle()
  v.live.stopVoice()
  await settle()
  const stream = v.fakeStream()
  v.gum.pending[0](stream) // the visitor clicks Allow after the call ended
  await settle()
  assert.ok(stream.tracks.every((t) => t.stopped), 'a mic allowed after hang-up must be released at once')
})
