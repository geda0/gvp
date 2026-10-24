import test from 'node:test'
import assert from 'node:assert/strict'

// ADR-0028 (+ addendum) — mic first, then greet. On the cold path (permission 'prompt' or
// unknown) the tap asks for the microphone AND opens the Live session in parallel, and the
// greeting is sent only after the grant, with the mic already wired. Driven through the REAL
// bindChatLiveVoice closure over a fake WebSocket and a getUserMedia the test answers by hand.
// test/mic-attach-wiring.test.mjs owns the rows that did not change (warm, one gUM per start);
// test/barge-in-wiring.test.mjs owns what the visitor can cut off once the call is up.

const MIC_PERMISSION_HINT =
  'Your browser is asking for the microphone — choose “Allow while visiting the site” so we don\'t ask again.'
const MIC_DISMISSED_MSG =
  'No microphone access yet — tap Start voice chat to be asked again.'
const DENIED_COPY = 'Microphone access was denied. Allow the mic for this site in your browser settings.'
const PERMISSION_WAIT_MS = 20000

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
    appendChild(child) { child.parent = el; el.children.push(child); return child },
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

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

// Timers of exactly PERMISSION_WAIT_MS are held, not scheduled: the test fires them by hand
// (the fake clock for the ignored-bubble row). Everything else runs on the real loop.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const heldTimers = new Set()
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms !== PERMISSION_WAIT_MS) return realSetTimeout(fn, ms, ...args)
  const held = { fn, args }
  heldTimers.add(held)
  return held
}
globalThis.clearTimeout = (id) => {
  if (heldTimers.has(id)) { heldTimers.delete(id); return }
  realClearTimeout(id)
}

const settle = async (turns = 10) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => realSetTimeout(resolve, 0))
}

/**
 * A chat with voice bound and NOT yet started.
 *   permission: what the Permissions API reports ('granted' | 'prompt' | 'denied' | undefined = no API).
 *               `v.perm.state` may be changed by the test (the re-query after a rejection).
 * getUserMedia is the browser's bubble: pending until the test calls v.gum.allow() / v.gum.reject(name).
 */
async function bootChat({ permission } = {}) {
  const sockets = []
  const messagesEl = makeEl('ul')
  const micButton = makeEl('button')
  const clicks = []
  micButton.dataset = {}
  micButton.disabled = false
  micButton.addEventListener = (type, fn) => { if (type === 'click') clicks.push(fn) }
  micButton.removeEventListener = () => {}
  const perm = { state: permission }
  const gum = { calls: 0, constraints: [], pending: [], streams: [] }
  gum.allow = () => {
    for (const p of gum.pending.splice(0)) {
      const tracks = [{ stopped: false, stop () { this.stopped = true } }]
      const stream = { tracks, getTracks: () => tracks }
      gum.streams.push(stream)
      p.resolve(stream)
    }
  }
  gum.reject = (name) => {
    for (const p of gum.pending.splice(0)) { const err = new Error('harness mic'); err.name = name; p.reject(err) }
  }
  gum.allTracksStopped = () => gum.streams.length > 0 && gum.streams.every((s) => s.tracks.every((t) => t.stopped))
  // What happened, in order, across the socket and the mic graph.
  const timeline = []
  const statuses = []
  const events = []
  const composerFocus = { count: 0 }

  defineGlobal('document', { querySelector: () => null, querySelectorAll: () => [], createElement: (t) => makeEl(t), addEventListener () {} })
  defineGlobal('window', {
    isSecureContext: true,
    location: { protocol: 'http:', hostname: 'portfolio.test', pathname: '/', hash: '', origin: 'http://portfolio.test' },
    matchMedia: () => ({ matches: false, addEventListener () {} }),
    addEventListener () {},
    gtag: (kind, name, params = {}) => {
      if (kind !== 'event') return
      const { transport_type: _t, ...rest } = params
      events.push({ name, params: rest })
    }
  })
  defineGlobal('navigator', {
    permissions: { query: async () => { if (!perm.state) throw new Error('no Permissions API'); return { state: perm.state } } },
    mediaDevices: {
      getUserMedia: (constraints) => {
        gum.calls += 1
        gum.constraints.push(JSON.parse(JSON.stringify(constraints)))
        timeline.push('getUserMedia')
        return new Promise((resolve, reject) => gum.pending.push({ resolve, reject }))
      }
    }
  })
  defineGlobal('AudioContext', class FakeAudioContext {
    constructor() { this.sampleRate = 24000; this.currentTime = 0; this.destination = {}; this.state = 'running' }
    async resume() {}
    createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel() {} } }
    createBufferSource() { return { buffer: null, onended: null, connect() {}, start() {}, stop() {} } }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} } }
    createMediaStreamSource() { timeline.push('mic wired'); return { connect() {}, disconnect() {} } }
    async close() {}
  })
  defineGlobal('WebSocket', class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url) {
      this.url = url; this.readyState = 1; this.sent = []
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null
      sockets.push(this)
      timeline.push('socket')
    }
    send(payload) {
      this.sent.push(payload)
      if (JSON.parse(payload).clientContent) timeline.push('greeting')
    }
    close() { this.readyState = 3 }
  })
  defineGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ websocketUrl: 'wss://chat.test/r', handshake: { setup: {} }, liveVoiceTransport: 'relay' }) }))
  const clock = { now: 5_000_000 }
  Date.now = () => clock.now
  heldTimers.clear()

  const { bindChatLiveVoice } = await import('../js/chat-live.js?micfirst=' + Math.random())
  const live = bindChatLiveVoice({
    messagesEl, statusEl: makeEl('p'), micButtons: [micButton], syncEmptyState () {}, scrollMessagesToBottom () {},
    setStatus: (text, kind) => { statuses.push({ text, kind }) },
    getSessionId: () => 'mic-first', isTextPending: () => false, openPanel () {}, isPanelOpen: () => true,
    patchLiveUi () {},
    focusComposer: () => { composerFocus.count += 1 }
  })
  const socket = () => sockets[sockets.length - 1]
  return {
    live,
    gum,
    perm,
    sockets,
    timeline,
    statuses,
    events,
    composerFocus,
    socket,
    advance: (ms) => { clock.now += ms },
    status: () => (statuses.length ? statuses[statuses.length - 1] : null),
    start: async () => { void live.startVoice({ intent: 'auto' }); await settle() },
    open: async () => { socket().onopen(); await settle() },
    setupComplete: async () => { socket().onmessage({ data: JSON.stringify({ setupComplete: {} }) }); await settle() },
    greetingsSent: () => sockets.flatMap((s) => s.sent.map((p) => JSON.parse(p))).filter((m) => 'clientContent' in m).length,
    fireWaitTimeout: async () => { for (const t of [...heldTimers]) { heldTimers.delete(t); t.fn(...t.args) } await settle() },
    tapMic: async () => { for (const fn of clicks) fn({ currentTarget: micButton }); await settle() },
    assistantBubbles: () => messagesEl.children
      .filter((node) => hasClass(node, 'chat-msg--assistant'))
      .map((node) => node.querySelector('.chat-msg__text')?.textContent || '')
  }
}

for (const permission of ['prompt', undefined]) {
  test(`cold path (${permission || 'unknown'}): the mic is asked before the session is ready, and no greeting is sent while the bubble is open`, async () => {
    // Arrange
    const v = await bootChat({ permission })
    try {
      // Act — tap Start; the session connects and completes setup; the bubble stays open.
      await v.start()
      const micAskedBeforeSetup = v.gum.calls
      await v.open()
      await v.setupComplete()

      // Assert
      assert.deepEqual(
        { micAskedBeforeSetup, greetingsSent: v.greetingsSent() },
        { micAskedBeforeSetup: 1, greetingsSent: 0 },
        'ADR-0028 §3.2: the bubble opens at the tap (in parallel with the connect) and the greeting ' +
        'waits for the grant — a greeting sent now plays under the browser sheet and its echo, ' +
        'picked up when the mic joins mid-sentence, cuts the greeting off'
      )
    } finally { v.live.dispose() }
  })
}

test('cold path: while the bubble is open the voice panel explains it, in exactly the owner\'s words', async () => {
  // Arrange
  const v = await bootChat({ permission: 'prompt' })
  try {
    // Act — the session is ready; the bubble is still open.
    await v.start()
    await v.open()
    await v.setupComplete()

    // Assert
    assert.deepEqual(
      v.status(),
      { text: MIC_PERMISSION_HINT, kind: undefined },
      'design-notes P1: the visitor is told what the browser sheet is and which choice stops it ' +
      'asking again (Chrome\'s one-time grant is why the owner was asked every visit)'
    )
  } finally { v.live.dispose() }
})
//@@END
