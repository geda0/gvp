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
async function bootChat({ permission, relay = false, holdMint = false } = {}) {
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
  // relay: a /api/live/relay/ URL (its pre-ready closes are retried). holdMint: the mint
  // answers only when the test calls v.releaseMint().
  const mint = { held: [] }
  const mintResponse = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ websocketUrl: relay ? 'wss://chat.test/api/live/relay/r' : 'wss://chat.test/r', handshake: { setup: {} }, liveVoiceTransport: 'relay' }) })
  defineGlobal('fetch', async () => (holdMint ? new Promise((resolve) => mint.held.push(() => resolve(mintResponse()))) : mintResponse()))
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
    releaseMint: async () => { for (const r of mint.held.splice(0)) r(); await settle() },
    /** 20 s timers still armed (the permission wait, a socket's open timeout). */
    armed20s: () => heldTimers.size,
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
test('cold path, grant after setup: the mic is wired BEFORE the greeting is sent, and the hint gives way to Listening', async () => {
  // Arrange — the session is ready and waiting on the bubble.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — the visitor clicks Allow.
    v.gum.allow()
    await settle()

    // Assert — the order, not just both: a greeting whose first frame plays to a mic that is
    // not yet live cannot be talked over (#25), and the AEC would start cold mid-sentence.
    assert.deepEqual(
      { order: v.timeline.filter((e) => e === 'mic wired' || e === 'greeting'), status: v.status().text },
      { order: ['mic wired', 'greeting'], status: 'Listening… speak about Marwan\'s work.' },
      'ADR-0028 §3.2 / §6.2: wired → greeting, in the grant\'s own continuation'
    )
  } finally { v.live.dispose() }
})

test('cold path, grant before setupComplete: the greeting waits for setup, then wire, then greet', async () => {
  // Arrange — the visitor allows while the session is still connecting.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    v.gum.allow()
    await settle()
    await v.open()
    const beforeSetup = v.timeline.filter((e) => e === 'mic wired' || e === 'greeting')

    // Act — setup completes.
    await v.setupComplete()

    // Assert
    assert.deepEqual(
      { beforeSetup, after: v.timeline.filter((e) => e === 'mic wired' || e === 'greeting') },
      { beforeSetup: [], after: ['mic wired', 'greeting'] },
      'ADR-0028 §6.3: wiring needs an open, set-up session; the greeting needs a live mic'
    )
  } finally { v.live.dispose() }
})
test('cold path, bubble dismissed (state still prompt): the call closes, no greeting, and the copy says "not yet", not "denied"', async () => {
  // Arrange — the session is ready and waiting on the bubble.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — the visitor closes the bubble with ✕: Chrome rejects exactly like a block, but the
    // permission is still 'prompt'.
    v.gum.reject('NotAllowedError')
    await settle()

    // Assert
    assert.deepEqual(
      { socketOpen: v.socket().readyState === 1, sessionOpen: v.live.isSessionOpen(), greetingsSent: v.greetingsSent(), status: v.status() },
      { socketOpen: false, sessionOpen: false, greetingsSent: 0, status: { text: MIC_DISMISSED_MSG, kind: 'error' } },
      'ADR-0028 §3.2 / P1: a dismissal is not a denial — sending the visitor to browser settings ' +
      'for a setting they never changed is false; and no Live session stays open, billed and silent'
    )
  } finally { v.live.dispose() }
})
test('cold path, bubble denied: the call closes with no voice greeting and falls back to text — greeting in the transcript, composer focused, denied copy', async () => {
  // Arrange — the session is ready and waiting on the bubble.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — the visitor clicks Block: the permission is now 'denied'.
    v.perm.state = 'denied'
    v.gum.reject('NotAllowedError')
    await settle()

    // Assert
    assert.deepEqual(
      {
        socketOpen: v.socket().readyState === 1,
        greetingsSent: v.greetingsSent(),
        transcript: v.assistantBubbles(),
        composerFocused: v.composerFocus.count > 0,
        status: v.status()
      },
      {
        socketOpen: false,
        greetingsSent: 0,
        transcript: ['Hi! I\'m Marwan\'s AI assistant. What would you like to know about his work?'],
        composerFocused: true,
        status: { text: DENIED_COPY, kind: 'error' }
      },
      'design-notes P2 / N-P1: a visitor who cannot answer by voice is not spoken to — the ' +
      'greeting arrives as text and the composer is ready'
    )
  } finally { v.live.dispose() }
})
test('already denied: no Live session is minted, no hint, and the visitor gets the text fallback at once (N-P1)', async () => {
  // Arrange — the site's mic permission was blocked on an earlier visit.
  const v = await bootChat({ permission: 'denied' })
  try {
    // Act — tap Start; the browser rejects without a bubble.
    await v.start()
    v.gum.reject('NotAllowedError')
    await settle()

    // Assert
    assert.deepEqual(
      {
        sockets: v.sockets.length,
        hintShown: v.statuses.some((s) => s.text === MIC_PERMISSION_HINT),
        transcript: v.assistantBubbles(),
        composerFocused: v.composerFocus.count > 0,
        status: v.status()
      },
      {
        sockets: 0,
        hintShown: false,
        transcript: ['Hi! I\'m Marwan\'s AI assistant. What would you like to know about his work?'],
        composerFocused: true,
        status: { text: DENIED_COPY, kind: 'error' }
      },
      'ADR-0028 addendum (N-P1): a known block is answered like a bubble Block — and there is no ' +
      'bubble to explain and nobody to speak to, so no billed session is opened for it'
    )
  } finally { v.live.dispose() }
})
test('cold path, no usable microphone (NotFoundError): the call closes, no greeting, today\'s device copy', async () => {
  // Arrange — the session is ready and waiting on the bubble.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — the browser has no input device to give.
    v.gum.reject('NotFoundError')
    await settle()

    // Assert
    assert.deepEqual(
      { socketOpen: v.socket().readyState === 1, sessionOpen: v.live.isSessionOpen(), greetingsSent: v.greetingsSent(), status: v.status(), transcript: v.assistantBubbles() },
      {
        socketOpen: false,
        sessionOpen: false,
        greetingsSent: 0,
        status: { text: 'No microphone was found. Connect a mic or pick an input device, then try again.', kind: 'error' },
        transcript: []
      },
      'ADR-0028 §3.2: every non-granted outcome closes the session and sends no greeting — and ' +
      'only a denial gets the text greeting (a missing device means "fix it and try voice again")'
    )
  } finally { v.live.dispose() }
})
test('cold path, bubble ignored for 20 s: the call closes with the "not yet" copy, and a grant after that is released', async () => {
  // Arrange — the session is ready and the bubble has been sitting there.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — PERMISSION_WAIT_MS (20 000) elapses; then the visitor finally clicks Allow.
    await v.fireWaitTimeout()
    const atTimeout = { socketOpen: v.socket().readyState === 1, sessionOpen: v.live.isSessionOpen(), status: v.status() }
    v.gum.allow()
    await settle()

    // Assert
    assert.deepEqual(
      { atTimeout, greetingsSent: v.greetingsSent(), lateMicReleased: v.gum.allTracksStopped() },
      {
        atTimeout: { socketOpen: false, sessionOpen: false, status: { text: MIC_DISMISSED_MSG, kind: 'error' } },
        greetingsSent: 0,
        lateMicReleased: true
      },
      'ADR-0028 addendum (N-P2): a billed Live session may not sit silent behind an unanswered ' +
      'bubble for more than 20 s, and a mic allowed after the call ended must not stay on'
    )
  } finally { v.live.dispose() }
})
test('hanging up (stopVoice) while the bubble is open: the hint goes, a later Allow is released silently, and Start works again at once', async () => {
  // Arrange — the session is ready and waiting on the bubble.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — the panel is closed (snapClose → stopVoice) with the bubble still up; the visitor
    // taps Start again before answering it; then answers the old bubble with Allow.
    v.live.stopVoice()
    await settle()
    const afterHangUp = { socketOpen: v.sockets[0].readyState === 1, status: v.status() }
    const statusesAt = v.statuses.length
    await v.start()
    const askedAgain = v.gum.calls
    v.gum.allow()
    await settle()

    // Assert
    assert.deepEqual(
      {
        afterHangUp,
        askedAgain,
        firstMicReleased: v.gum.streams[0].tracks.every((t) => t.stopped),
        greetingsOnFirstSocket: v.sockets[0].sent.filter((p) => JSON.parse(p).clientContent).length,
        errorCopy: v.statuses.slice(statusesAt).filter((s) => s.kind === 'error')
      },
      {
        afterHangUp: { socketOpen: false, status: { text: '', kind: undefined } },
        askedAgain: 2,
        firstMicReleased: true,
        greetingsOnFirstSocket: 0,
        errorCopy: []
      },
      'ADR-0028 §3.2 stale-start guard: an ended start never greets, reports or holds the next ' +
      'Start hostage to a bubble nobody will answer'
    )
  } finally { v.live.dispose() }
})
const voiceStarts = (v) => v.events.filter((e) => e.name === 'chat_voice_start').map((e) => e.params)

test('telemetry: a cold start records ONE chat_voice_start with the permission before, the outcome and the wait', async () => {
  // Arrange
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — the visitor reads the bubble for 1.5 s, then allows.
    v.advance(1500)
    v.gum.allow()
    await settle()

    // Assert — exactly these keys: no audio, transcript, error text or device ids (P1).
    assert.deepEqual(
      voiceStarts(v),
      [{ permissionBefore: 'prompt', outcome: 'granted', waitMs: 1500 }],
      'design-notes P1: every voice start carries permissionBefore, outcome and the bubble wait — ' +
      'the only way to see whether real visitors are re-prompted (N-P4)'
    )
  } finally { v.live.dispose() }
})
// Each non-granted outcome: how the test makes it happen, and what both events must say.
const OUTCOMES = {
  dismissed: async (v) => { v.gum.reject('NotAllowedError') },
  denied: async (v) => { v.perm.state = 'denied'; v.gum.reject('NotAllowedError') },
  timeout: async (v) => { v.advance(PERMISSION_WAIT_MS); await v.fireWaitTimeout() },
  error: async (v) => { v.gum.reject('NotReadableError') }
}
for (const [outcome, happen] of Object.entries(OUTCOMES)) {
  test(`telemetry: a ${outcome} bubble is one chat_voice_start and one chat_live_stop {reason: 'mic_permission'}, exactly these keys`, async () => {
    // Arrange
    const v = await bootChat({ permission: 'prompt' })
    try {
      await v.start()
      await v.open()
      await v.setupComplete()
      v.advance(800)

      // Act
      await happen(v)
      await settle()

      // Assert
      assert.deepEqual(
        {
          starts: voiceStarts(v),
          stops: v.events.filter((e) => e.name === 'chat_live_stop').map((e) => e.params)
        },
        {
          starts: [{ permissionBefore: 'prompt', outcome, waitMs: outcome === 'timeout' ? 800 + PERMISSION_WAIT_MS : 800 }],
          stops: [{ reason: 'mic_permission', permissionBefore: 'prompt', outcome }]
        },
        'ADR-0028 addendum §3: the outcome is what the funnel needs to tell a dismissal from a ' +
        'block from a visitor who never answered'
      )
    } finally { v.live.dispose() }
  })
}

test('telemetry: hanging up during the bubble is outcome "hangup", with the c841477 stop reason and no mic_permission stop', async () => {
  // Arrange
  const v = await bootChat({ permission: undefined })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()
    v.advance(1000)

    // Act — the mic tap is the visitor's "End" while the bubble is up.
    await v.tapMic()

    // Assert
    assert.deepEqual(
      {
        starts: voiceStarts(v),
        stops: v.events.filter((e) => e.name === 'chat_live_stop').map((e) => e.params)
      },
      {
        starts: [{ permissionBefore: 'unknown', outcome: 'hangup', waitMs: 1000 }],
        stops: [{ reason: 'abort_mic_prompt' }]
      },
      'the visitor ended it; the browser did not answer — so no mic_permission outcome is claimed'
    )
  } finally { v.live.dispose() }
})

test('telemetry: a warm start (already granted) waits 0 ms, and chat_live_start says how the mic came to be live', async () => {
  // Arrange
  const v = await bootChat({ permission: 'granted' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()
    v.advance(300)

    // Act — getUserMedia resolves without a bubble.
    v.gum.allow()
    await settle()

    // Assert
    assert.deepEqual(
      {
        starts: voiceStarts(v),
        liveStarts: v.events.filter((e) => e.name === 'chat_live_start').map((e) => e.params),
        hintShown: v.statuses.some((s) => s.text === MIC_PERMISSION_HINT)
      },
      {
        starts: [{ permissionBefore: 'granted', outcome: 'granted', waitMs: 0 }],
        liveStarts: [{ permissionBefore: 'granted', outcome: 'granted' }],
        hintShown: false
      },
      'design-notes P1: no bubble, no hint, no wait; the warm path is otherwise unchanged'
    )
  } finally { v.live.dispose() }
})
test('telemetry: chat_voice_start is emitted by startVoice only — the Start tap in chat.js no longer sends its own', async () => {
  // Arrange — js/chat.js with comments stripped.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../js/chat.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

  // Act
  const tapEmits = [...src.matchAll(/trackEvent\(\s*['"]chat_voice_start['"]/g)].length

  // Assert
  assert.equal(
    tapEmits, 0,
    'ADR-0028 §5 + addendum: two emitters would double-count every start, and the tap\'s copy ' +
    'carries no permissionBefore / outcome'
  )
})
test('telemetry: the Start button\'s click tracking (data-track) does not reuse the name chat_voice_start', async () => {
  // Arrange — MEASURED by scripts/qa/voice-stage-probe.mjs on stage: bindOutboundTracking sent a
  // second chat_voice_start {event_category: 'Outbound'} for every tap, next to startVoice's.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../js/chat.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

  // Act — chat.js re-labels the button at runtime; index.html labels it before chat.js runs.
  const reused = [...src.matchAll(/['"]data-track['"]\s*,\s*['"]chat_voice_start['"]/g)].length +
    [...html.matchAll(/data-track="chat_voice_start"/g)].length

  // Assert
  assert.equal(
    reused, 0,
    'one start, one chat_voice_start: the funnel counts it as engagement, so a duplicate inflates it'
  )
})

test('getUserMedia asks with the same constraints on the first start, after a dismissal, and after a hang-up', async () => {
  // Arrange
  const v = await bootChat({ permission: 'prompt' })
  try {
    // Act — start / dismiss; start again / hang up; start a third time.
    await v.start()
    v.gum.reject('NotAllowedError')
    await settle()
    await v.start()
    await v.tapMic()
    await v.start()

    // Assert
    const audio = { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    assert.deepEqual(
      v.gum.constraints,
      [{ audio, video: false }, { audio, video: false }, { audio, video: false }],
      'design-notes P1: a constraint that changed between calls could be read by the browser as a ' +
      'new request — pinned so it can never be why the visitor is asked again'
    )
  } finally { v.live.dispose() }
})
test('the hint leaves with the bubble: a grant while the session is still connecting shows "Connecting voice…"', async () => {
  // Arrange — the bubble is up before the mint has returned.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    const whileOpen = v.status().text

    // Act — Allow, with the socket not yet open.
    v.gum.allow()
    await settle()

    // Assert
    assert.deepEqual(
      { whileOpen, afterGrant: v.status().text },
      { whileOpen: MIC_PERMISSION_HINT, afterGrant: 'Connecting voice…' },
      'design-notes P1: the hint disappears as soon as the request settles, whatever the session is doing'
    )
  } finally { v.live.dispose() }
})
test('cold path: a call closed without a greeting puts the chat lifecycle back to idle (no aura stuck "thinking")', async () => {
  // Arrange — the lifecycle bus the agent node and the spaceman render from.
  const { chatBus } = await import('../js/chat-bus.js')
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()
    const busyWhileWaiting = chatBus.getState().state !== 'idle'

    // Act — the bubble is dismissed.
    v.gum.reject('NotAllowedError')
    await settle()

    // Assert
    assert.deepEqual(
      { busyWhileWaiting, afterClose: chatBus.getState().state },
      { busyWhileWaiting: true, afterClose: 'idle' },
      'the start (and setupComplete) put the lifecycle to work; a close that never greets must ' +
      'say the chat is idle again'
    )
  } finally { v.live.dispose() }
})

test('cold path: a session that fails after the grant releases the granted mic and shows the connect error', async () => {
  // Arrange — the visitor allows while the socket is still opening.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    v.gum.allow()
    await settle()

    // Act — the socket dies before it is ready.
    v.socket().onclose({ code: 1006, reason: '' })
    await settle()

    // Assert
    assert.deepEqual(
      { micReleased: v.gum.allTracksStopped(), greetingsSent: v.greetingsSent(), statusKind: v.status().kind },
      { micReleased: true, greetingsSent: 0, statusKind: 'error' },
      'ADR-0028 §3.2: no mic may stay on for a call that never came up (the grant is not wasted: ' +
      'the next tap is warm)'
    )
  } finally { v.live.dispose() }
})

test('End while the granted mic waits on a still-CONNECTING socket: the mic is released at once, Start works again, no error copy', async () => {
  // Arrange — the visitor allows before the socket has opened.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    v.gum.allow()
    await settle()

    // Act — the mic tap ("End"); the dead socket's open timeout (20 s) elapses; Start again.
    await v.tapMic()
    const released = v.gum.allTracksStopped()
    await v.fireWaitTimeout()
    const asksBefore = v.gum.calls
    await v.start()
    const askedAgain = v.gum.calls - asksBefore

    // Assert
    assert.deepEqual(
      { released, askedAgain, errorCopy: v.statuses.filter((s) => s.kind === 'error').map((s) => s.text) },
      { released: true, askedAgain: 1, errorCopy: [] },
      'critic (ADR-0028 §3.2): an ended start must not hold the mic, Start, or a late ' +
      '"did not connect" for a socket the visitor already abandoned'
    )
  } finally { v.live.dispose() }
})

test('a start ended while its socket was CONNECTING never touches the next call: socket 2 survives and greets after the grant', async () => {
  // Arrange — tap Start; hang up before socket 1 opens; tap Start again.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.tapMic()
    await v.start()
    const second = v.socket()

    // Act — call 2 comes up and is allowed; then every 20 s timer still held (socket 1's open
    // timeout included, if anything left it armed) fires.
    await v.open()
    await v.setupComplete()
    v.gum.allow()
    await settle()
    await v.fireWaitTimeout()

    // Assert
    assert.deepEqual(
      {
        sockets: v.sockets.length,
        secondOpen: second.readyState === 1 && v.live.isSessionOpen(),
        secondGreeted: second.sent.filter((p) => JSON.parse(p).clientContent).length,
        errorCopy: v.statuses.filter((s) => s.kind === 'error').map((s) => s.text)
      },
      { sockets: 2, secondOpen: true, secondGreeted: 1, errorCopy: [] },
      'critic M2: the abandoned connect\'s failure path must not stop `ws` — by then it is call 2\'s'
    )
  } finally { v.live.dispose() }
})

test('a session that dies under the open bubble is a connect error, not a hang-up: error copy, outcome "error", chat_live_error', async () => {
  // Arrange — the session is ready and waiting on the bubble.
  const { chatBus } = await import('../js/chat-bus.js')
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act — the server closes the session.
    v.socket().onclose({ code: 1011, reason: 'internal error' })
    await settle()

    // Assert
    assert.deepEqual(
      {
        statusKind: v.status().kind,
        outcome: voiceStarts(v).map((s) => s.outcome),
        liveErrors: v.events.filter((e) => e.name === 'chat_live_error').length,
        lifecycle: chatBus.getState().state,
        hintLeft: v.status().text !== MIC_PERMISSION_HINT
      },
      { statusKind: 'error', outcome: ['error'], liveErrors: 1, lifecycle: 'error', hintLeft: true },
      'critic M3: only the visitor or the page ends the wait as a hang-up; a dead session is reported'
    )
  } finally { v.live.dispose() }
})

test('a session that dies after the bubble is answered Allow still releases the mic (failure while the grant waits on setup)', async () => {
  // Arrange — the socket is open, the visitor allows, setup has not completed.
  const v = await bootChat({ permission: 'prompt', relay: false })
  try {
    await v.start()
    await v.open()
    v.gum.allow()
    await settle()

    // Act — the socket dies before setup.
    v.socket().onclose({ code: 1006, reason: '' })
    await settle()

    // Assert
    assert.deepEqual(
      { released: v.gum.allTracksStopped(), statusKind: v.status().kind, greetingsSent: v.greetingsSent() },
      { released: true, statusKind: 'error', greetingsSent: 0 },
      'a granted mic is never left live for a call that failed to come up'
    )
  } finally { v.live.dispose() }
})

test('hanging up while the session mint is in flight: no socket is ever opened for the ended call', async () => {
  // Arrange — the mint has not answered yet; the bubble is open.
  const v = await bootChat({ permission: 'prompt', holdMint: true })
  try {
    await v.start()

    // Act — End, then the mint answers.
    await v.tapMic()
    await v.releaseMint()

    // Assert
    assert.equal(v.sockets.length, 0, 'ADR-0028 §3.2 stale-start guard: a mint that returns after the call ended opens nothing')
  } finally { v.live.dispose() }
})

test('relay: a socket that closes before it is ready is still retried while the bubble is open', async () => {
  // Arrange — a relay session; the bubble is open; the first socket has not opened.
  const v = await bootChat({ permission: 'prompt', relay: true })
  try {
    await v.start()

    // Act — the relay drops it before ready; the connect loop backs off (800 ms) and retries.
    v.socket().onclose({ code: 1006, reason: '' })
    await new Promise((resolve) => realSetTimeout(resolve, 1100))
    await settle()

    // Assert
    assert.deepEqual(
      { sockets: v.sockets.length, hintStillUp: v.statuses.some((s) => s.text === MIC_PERMISSION_HINT) && v.gum.pending.length === 1 },
      { sockets: 2, hintStillUp: true },
      'a pre-ready close is a connect retry (retrying: !ready), not the end of the start'
    )
  } finally { v.live.dispose() }
})

test('no Permissions API (unknown) and NotAllowedError: the denied copy and the text fallback, never "not yet"', async () => {
  // Arrange
  const v = await bootChat({ permission: undefined })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()

    // Act
    v.gum.reject('NotAllowedError')
    await settle()

    // Assert
    assert.deepEqual(
      { status: v.status(), transcript: v.assistantBubbles() },
      { status: { text: DENIED_COPY, kind: 'error' }, transcript: ['Hi! I\'m Marwan\'s AI assistant. What would you like to know about his work?'] },
      'ADR-0028 §3.2: a dismissal is claimed only when the browser SAYS the state is still prompt'
    )
  } finally { v.live.dispose() }
})

test('cold grant, then a mic tap while the greeting plays: the tap ends the call and releases the mic', async () => {
  // Arrange — granted, wired, greeting audio arriving.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()
    await v.open()
    await v.setupComplete()
    v.gum.allow()
    await settle()
    const audio = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa(String.fromCharCode(0, 1, 0, 2)) } }
    v.socket().onmessage({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [audio] } } }) })
    await settle()
    const liveBefore = v.live.isActive()

    // Act
    await v.tapMic()

    // Assert
    assert.deepEqual(
      { liveBefore, sessionOpen: v.live.isSessionOpen(), socketOpen: v.socket().readyState === 1, released: v.gum.allTracksStopped() },
      { liveBefore: true, sessionOpen: false, socketOpen: false, released: true },
      'invariant #20/#25: on a live mic the tap is the visitor\'s End, on the cold path too'
    )
  } finally { v.live.dispose() }
})

test('End after Allow while the session mint is still in flight: the mic is released at once, not when the mint returns', async () => {
  // Arrange — Allow arrives before the mint has answered.
  const v = await bootChat({ permission: 'prompt', holdMint: true })
  try {
    await v.start()
    v.gum.allow()
    await settle()

    // Act — End; the mint is still out.
    await v.tapMic()
    const released = v.gum.allTracksStopped()
    const asksBefore = v.gum.calls
    await v.start()

    // Assert
    assert.deepEqual(
      { released, askedAgain: v.gum.calls - asksBefore },
      { released: true, askedAgain: 1 },
      'critic M1: the granted mic waits on the session OR a stop, whichever comes first'
    )
  } finally { v.live.dispose() }
})

test('End while the socket is CONNECTING leaves no 20 s open-timeout armed for the abandoned socket', async () => {
  // Arrange — the bubble is open and socket 1 has not opened.
  const v = await bootChat({ permission: 'prompt' })
  try {
    await v.start()

    // Act
    await v.tapMic()

    // Assert — the permission wait and the socket's open wait both ended with the call.
    assert.equal(
      v.armed20s(), 0,
      'critic M1: a stop rejects the pending socket-open wait (LiveSetupAbort) instead of leaving ' +
      'a LIVE_WS_OPEN_MS timer to report "did not connect" — or stop the next call — later'
    )
  } finally { v.live.dispose() }
})
