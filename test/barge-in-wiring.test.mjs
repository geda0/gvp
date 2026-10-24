import test from 'node:test'
import assert from 'node:assert/strict'

// Invariant #25 (ADR-0026 §2-§3): the visitor can always cut the assistant off — by voice or
// by any explicit act — on every path, cold or warm. This file drives the REAL
// bindChatLiveVoice closure over a fake WebSocket and a fake AudioContext and asks the
// browser-visible questions:
//   - does mic audio go upstream WHILE the greeting is still speaking (so Live can raise
//     `interrupted` at all)?
//   - does an explicit act (a chip / text turn into the call, a mic tap) stop playback
//     locally, before any server frame?
//   - does the reply to that act still play (the gate is not left shut)?
// test/voice-turn-gate.test.mjs owns the gate's table; test/voice-turn-gate-wiring.test.mjs
// owns the server-interrupt sinks; test/mic-attach-wiring.test.mjs owns WHEN getUserMedia runs.

const AUDIO_MIME = 'audio/pcm;rate=24000'
const AUDIO_DATA = btoa(String.fromCharCode(0, 1, 0, 2, 0, 3, 0, 4))
const audioPart = () => ({ inlineData: { mimeType: AUDIO_MIME, data: AUDIO_DATA } })

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

// One fake AudioContext class for both the player and the mic. Every buffer source is
// recorded with its started/stopped flags: "playing" = started and not stopped. Every
// ScriptProcessor is recorded so a test can push a mic frame through it. `suspendNext`
// makes the next context start suspended with a resume() the test resolves by hand.
function makeAudio() {
  const audio = { sources: [], processors: [], suspendNext: false, resumeGates: [] }
  audio.playing = () => audio.sources.filter((s) => s.started && !s.stopped).length
  audio.started = () => audio.sources.filter((s) => s.started).length
  audio.Ctx = class FakeAudioContext {
    constructor() {
      this.sampleRate = 24000
      this.currentTime = 0
      this.destination = {}
      this.state = audio.suspendNext ? 'suspended' : 'running'
      this.gated = audio.suspendNext
      audio.suspendNext = false
    }
    resume() {
      if (!this.gated) return Promise.resolve()
      return new Promise((resolve) => audio.resumeGates.push(() => { this.state = 'running'; resolve() }))
    }
    createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel() {} } }
    createBufferSource() {
      const src = {
        buffer: null,
        onended: null,
        started: false,
        stopped: false,
        connect() {},
        start() { src.started = true },
        stop() { src.stopped = true }
      }
      audio.sources.push(src)
      return src
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createScriptProcessor() {
      const p = { onaudioprocess: null, connect() {}, disconnect() {} }
      audio.processors.push(p)
      return p
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    async close() {}
  }
  return audio
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

/**
 * Boots a live session that has sent its greeting and is waiting for it to speak.
 *   permission: what the Permissions API reports ('granted' | 'prompt' | undefined = no API)
 *   mic:        'allow' (getUserMedia yields a stream) | 'deny' (it rejects)
 */
async function bootVoice({ permission, mic = 'allow' } = {}) {
  const sockets = []
  const audio = makeAudio()
  const messagesEl = makeEl('ul')
  const micButton = makeEl('button')
  const clicks = []
  micButton.dataset = {}
  micButton.disabled = false
  micButton.addEventListener = (type, fn) => { if (type === 'click') clicks.push(fn) }
  micButton.removeEventListener = () => {}
  // Every stream handed out is kept so a test can ask whether its tracks were stopped; a
  // 'pending' mic is the browser's permission sheet, settled by the test (allow / deny).
  const gum = { calls: 0, tracks: [], pending: [] }
  const makeStream = () => {
    const tracks = [{ stopped: false, stop () { this.stopped = true } }]
    gum.tracks.push(...tracks)
    return { getTracks: () => tracks }
  }
  gum.allow = () => { for (const p of gum.pending.splice(0)) p.resolve(makeStream()) }
  gum.deny = () => {
    for (const p of gum.pending.splice(0)) { const err = new Error('harness mic'); err.name = 'NotAllowedError'; p.reject(err) }
  }
  const patches = []
  const statuses = []

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
        gum.calls += 1
        if (mic === 'deny') { const err = new Error('harness mic'); err.name = 'NotAllowedError'; throw err }
        if (mic === 'pending') return new Promise((resolve, reject) => gum.pending.push({ resolve, reject }))
        return makeStream()
      }
    }
  })
  defineGlobal('AudioContext', audio.Ctx)
  defineGlobal('WebSocket', makeWebSocketClass(sockets))
  defineGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ websocketUrl: 'wss://chat.test/r', handshake: { setup: {} }, liveVoiceTransport: 'relay' }) }))
  const { bindChatLiveVoice } = await import('../js/chat-live.js?bargein=' + Math.random())
  const live = bindChatLiveVoice({
    messagesEl, statusEl: makeEl('p'), micButtons: [micButton], syncEmptyState () {}, scrollMessagesToBottom () {},
    setStatus: (text, kind) => { statuses.push({ text, kind }) },
    getSessionId: () => 'barge-in', isTextPending: () => false, openPanel () {}, isPanelOpen: () => true,
    patchLiveUi: (patch) => { patches.push(patch) }
  })
  void live.startVoice({ intent: 'auto' })
  await settle()
  const socket = sockets[0]
  socket.onopen(); await settle()
  socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) }); await settle()

  const sentOfKind = (key) => socket.sent.map((p) => JSON.parse(p)).filter((m) => key in m)
  return {
    live,
    audio,
    gum,
    socket,
    patches,
    statuses,
    sentOfKind,
    tapMic: async () => { for (const fn of clicks) fn({ currentTarget: micButton }); await settle() },
    send: async (payload) => { socket.onmessage({ data: JSON.stringify(payload) }); await settle() },
    bubbleTexts: (role) => messagesEl.children
      .filter((node) => hasClass(node, `chat-msg--${role}`))
      .map((node) => node.querySelector('.chat-msg__text')?.textContent || '')
  }
}

test('cold path: once the visitor allows the mic, its audio goes upstream while the greeting is still speaking', async () => {
  // Arrange — first visit (permission prompt), the greeting is speaking, no turnComplete yet.
  const v = await bootVoice({ permission: 'prompt', mic: 'allow' })
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })

    // Act — the mic graph delivers one frame of the visitor's voice.
    for (const p of v.audio.processors) {
      p.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } })
    }

    // Assert — upstream audio is what lets Gemini Live's activity detection fire `interrupted`.
    assert.ok(
      v.sentOfKind('realtimeInput').length > 0,
      'with no mic audio upstream during the greeting, Live can never raise `interrupted`, and ' +
      'the greeting cannot be talked over (the 2026-10-23 regression)'
    )
  } finally { v.live.dispose() }
})

test('cold path: `interrupted` during the greeting stops playback at once, drops its tail, and the next turn plays', async () => {
  // Arrange — first visit, mic allowed at once, the greeting speaking (two chunks playing).
  const v = await bootVoice({ permission: 'prompt', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart(), audioPart()] } } })

    // Act — Live's activity detection fires on the visitor's voice; the dead greeting's tail
    // still arrives before its turnComplete; then the answer.
    await v.send({ serverContent: { interrupted: true } })
    const playingAfterInterrupt = v.audio.playing()
    const startedAtInterrupt = v.audio.started()
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Hi! I am the greeting' } } })
    const tailStarted = v.audio.started() - startedAtInterrupt
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'He builds AI agents.' } } })

    observed = {
      playingAfterInterrupt,
      tailStarted,
      answerPlaying: v.audio.playing(),
      assistantBubbles: v.bubbleTexts('assistant')
    }
  } finally { v.live.dispose() }

  // Assert
  assert.deepEqual(
    observed,
    { playingAfterInterrupt: 0, tailStarted: 0, answerPlaying: 1, assistantBubbles: ['He builds AI agents.'] },
    'G1: on the cold path the greeting must stop at once, nothing of it may play or be appended ' +
    'after the cut, and the visitor\'s next turn must not be stuck muted'
  )
})

// G2: an explicit act stops playback LOCALLY — no server round-trip — on both paths.
// Before ADR-0026 a chip or text turn into the call relied on the server to cut the audio,
// and a mic tap on an open session only attached the mic: buffered greeting audio kept
// playing over the visitor's own action. The matrix is 3 acts × {cold, granted}.
//   chip / text: both reach the call through live.sendUserText (js/chat.js routes the chip
//                there during a call); the mic is live.
//   mic tap:     cold = the mic is NOT live (attach refused), so the tap stops playback and
//                then raises the permission sheet again; granted = the mic IS live, so the tap
//                ends the call (#20's explicit act), which silences it too.
const PATHS = {
  cold: { permission: 'prompt' },
  granted: { permission: 'granted' }
}
// `call` is what each act must do to the CALL besides silencing it. A mic tap on a LIVE mic
// must still hang up (the explicit act of #20) — silencing alone would also pass the playback
// assertion, which is exactly the mutant (`if (active)` never taken) the critic found alive.
const stillOpen = (v) => ({ sessionOpen: v.live.isSessionOpen() })
const ACTS = {
  chip: {
    mic: () => 'allow',
    act: (v) => v.live.sendUserText('Summarize Apptio (an IBM company) for me.'),
    call: stillOpen,
    expect: () => ({ sessionOpen: true })
  },
  text: {
    mic: () => 'allow',
    act: (v) => v.live.sendUserText('What does he actually build?'),
    call: stillOpen,
    expect: () => ({ sessionOpen: true })
  },
  'mic tap': {
    mic: (path) => (path === 'cold' ? 'deny' : 'allow'),
    act: (v) => v.tapMic(),
    call: (v) => ({
      sessionOpen: v.live.isSessionOpen(),
      micRequests: v.gum.calls,
      micTracksStopped: v.gum.tracks.every((t) => t.stopped)
    }),
    // cold: mic not live -> the tap cuts playback, keeps the call and raises the sheet again.
    // granted: mic live -> the tap ends the call and releases the mic.
    expect: (path) => (path === 'cold'
      ? { sessionOpen: true, micRequests: 2, micTracksStopped: true }
      : { sessionOpen: false, micRequests: 1, micTracksStopped: true })
  }
}

for (const [pathName, path] of Object.entries(PATHS)) {
  for (const [actName, { mic, act, call, expect }] of Object.entries(ACTS)) {
    test(`${pathName} path: a ${actName} while the assistant is speaking stops playback locally, before any server frame`, async () => {
      // Arrange — the greeting is speaking: two chunks queued and playing.
      const v = await bootVoice({ ...path, mic: mic(pathName) })
      try {
        await v.send({ serverContent: { modelTurn: { parts: [audioPart(), audioPart()] } } })
        const playingBefore = v.audio.playing()

        // Act — the visitor's explicit act; NO server frame follows.
        await act(v)

        // Assert
        assert.deepEqual(
          { playingBefore, playingAfter: v.audio.playing(), call: call(v) },
          { playingBefore: 2, playingAfter: 0, call: expect(pathName) },
          `a ${actName} must cut the assistant off at once (invariant #25) — the server's ` +
          '`interrupted` may never come for a clientContent turn, and a visitor who acted ' +
          'should not have to sit through the rest of the sentence'
        )
      } finally { v.live.dispose() }
    })
  }
}

test('a chip sent mid-greeting drops the rest of the greeting, audio and transcript, then its own reply plays', async () => {
  // Arrange — the greeting is mid-flight: audio playing, its transcript started.
  const v = await bootVoice({ permission: 'granted', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Hi! I am' } } })

    // Act — the chip goes into the call; Live keeps flushing the abandoned greeting before
    // that turn's turnComplete, then answers the chip.
    v.live.sendUserText('Summarize Apptio (an IBM company) for me.')
    await settle()
    const startedAtChip = v.audio.started()
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: " Marwan's assistant." } } })
    const greetingTailStarted = v.audio.started() - startedAtChip
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Apptio is cost software.' } } })
    await v.send({ serverContent: { turnComplete: true } })

    observed = {
      greetingTailStarted,
      replyStarted: v.audio.started() - startedAtChip - greetingTailStarted,
      assistantBubbles: v.bubbleTexts('assistant')
    }
  } finally { v.live.dispose() }

  // Assert
  assert.deepEqual(
    observed,
    {
      greetingTailStarted: 0,
      replyStarted: 1,
      assistantBubbles: ['Hi! I am', 'Apptio is cost software.']
    },
    'a local act on a turn IN FLIGHT cancels that turn until its turnComplete (nothing more of ' +
    'the cut-off greeting plays or is appended), and the gate re-opens for the chip\'s own reply'
  )
})

// The two turnStarted triggers (ADR-0026 §3.2), each pinned by a path where it is the ONLY way
// the gate learns a turn is in flight. Without the trigger the gate is idle at the chip, a
// local cut leaves it open, and the cut-off turn's later frames play over the chip's reply.

test('a chip that cuts a reply to the visitor\'s VOICE drops the rest of that reply (turn seen only via model output)', async () => {
  // Arrange — greeting done; the visitor spoke; the model's reply to it is streaming. No
  // clientContent started this turn: only its model output says it is in flight.
  const v = await bootVoice({ permission: 'granted', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { inputTranscription: { text: 'What does he build?' } } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'He builds' } } })

    // Act — the chip; Live flushes more of the reply it abandoned, ends it, answers the chip.
    v.live.sendUserText('Summarize Apptio (an IBM company) for me.')
    await settle()
    const startedAtChip = v.audio.started()
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: ' AI agents.' } } })
    const abandonedTailStarted = v.audio.started() - startedAtChip
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Apptio is cost software.' } } })

    observed = { abandonedTailStarted, chipReplyPlaying: v.audio.playing() }
  } finally { v.live.dispose() }

  // Assert
  assert.deepEqual(
    observed,
    { abandonedTailStarted: 0, chipReplyPlaying: 1 },
    'model output must mark the turn in flight (turnStarted), or a chip cannot cut a reply to the visitor\'s voice'
  )
})

test('the root-level transcript shape marks a turn in flight too: a chip stops its later fragments appending', async () => {
  // Arrange — greeting done; the reply to the visitor's voice is arriving ONLY as root-level
  // outputTranscription (one of the wire shapes the handler accepts).
  const v = await bootVoice({ permission: 'granted', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ outputTranscription: { text: 'He builds' } })

    // Act
    v.live.sendUserText('Summarize Apptio (an IBM company) for me.')
    await settle()
    await v.send({ outputTranscription: { text: ' AI agents.' } })
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ outputTranscription: { text: 'Apptio is cost software.' } })
    await v.send({ serverContent: { turnComplete: true } })

    observed = v.bubbleTexts('assistant')
  } finally { v.live.dispose() }

  // Assert
  assert.deepEqual(observed, ['He builds', 'Apptio is cost software.'])
})

test('a chip sent after the greeting request but before any greeting output drops the greeting (turn seen only via the send)', async () => {
  // Arrange — the greeting clientContent is out; nothing of it has arrived yet.
  const v = await bootVoice({ permission: 'granted', mic: 'allow' })
  let observed = null
  try {
    // Act — the chip, then the greeting Live already started, its end, the chip's reply.
    v.live.sendUserText('Summarize Apptio (an IBM company) for me.')
    await settle()
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Hi! I am the greeting.' } } })
    const greetingStarted = v.audio.started()
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Apptio is cost software.' } } })
    await v.send({ serverContent: { turnComplete: true } })

    observed = { greetingStarted, chipReplyStarted: v.audio.started() - greetingStarted, assistantBubbles: v.bubbleTexts('assistant') }
  } finally { v.live.dispose() }

  // Assert
  assert.deepEqual(
    observed,
    { greetingStarted: 0, chipReplyStarted: 1, assistantBubbles: ['Apptio is cost software.'] },
    'sending a clientContent turn must mark it in flight (turnStarted) — a turn requested but not ' +
    'yet answered is still one a chip has to cut'
  )
})

test('a server `interrupted` with no turn in flight still cancels: the server reason is not a local one', async () => {
  // Arrange — the greeting has completed (gate idle, nothing in flight).
  const v = await bootVoice({ permission: 'granted', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })
    await v.send({ serverContent: { turnComplete: true } })
    const startedBefore = v.audio.started()

    // Act — Live cuts a turn the client has not seen any output of yet; a stale frame follows.
    await v.send({ serverContent: { interrupted: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })

    observed = v.audio.started() - startedBefore
  } finally { v.live.dispose() }

  // Assert
  assert.equal(
    observed, 0,
    'ADR-0026 §3.1: the server\'s `interrupted` is unconditional (idle -> cancelled); only the ' +
    'LOCAL reasons spare an idle gate'
  )
})

// The permission sheet is now open OVER the greeting on every first visit (ADR-0026 §2), so
// "hang up, then answer the sheet" is a common path. Whatever the answer, the dead call must
// not come back to life in the UI: no sessionOpen:true patch, no error status, no no-mic sweep.
for (const [pathName, permission, answer] of [['cold', 'prompt', 'allow'], ['cold', 'prompt', 'deny'], ['warm', 'granted', 'deny']]) {
  test(`${pathName} path: hanging up while the permission sheet is open, then ${answer === 'allow' ? 'Allow' : 'Deny'}, leaves the call ended and silent`, async () => {
    // Arrange — the call is up and getUserMedia is waiting on the sheet.
    const v = await bootVoice({ permission, mic: 'pending' })
    let observed = null
    try {
      // Act — hang up, then the visitor answers the sheet.
      v.live.stopVoice()
      await settle()
      const patchesAt = v.patches.length
      const statusesAt = v.statuses.length
      v.gum[answer]()
      await settle()

      observed = {
        sessionOpen: v.live.isSessionOpen(),
        reopenedInUi: v.patches.slice(patchesAt).some((p) => p.sessionOpen === true),
        errorStatuses: v.statuses.slice(statusesAt).filter((s) => s.kind === 'error').map((s) => s.text)
      }
    } finally { v.live.dispose() }

    // Assert
    assert.deepEqual(
      observed,
      { sessionOpen: false, reopenedInUi: false, errorStatuses: [] },
      'a mic answer that arrives after the call ended must not re-patch the UI open or report an error'
    )
  })
}

// While the sheet is pending the mic button is the visitor's only "End": startVoice is still
// awaiting the attach, so before this fix the tap only cut playback locally and the call could
// not be ended from the mic at all until the sheet was answered.
for (const [pathName, permission] of [['cold', 'prompt'], ['warm', 'granted']]) {
  test(`${pathName} path: tapping the mic while the permission sheet is open hangs up, and a later Allow is released`, async () => {
    // Arrange — the call is up, the sheet is open, the greeting is playing.
    const v = await bootVoice({ permission, mic: 'pending' })
    let observed = null
    try {
      await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })

      // Act — the tap, then the visitor clicks Allow on the sheet anyway.
      await v.tapMic()
      const afterTap = { sessionOpen: v.live.isSessionOpen(), playing: v.audio.playing() }
      v.gum.allow()
      await settle()

      observed = { afterTap, micTracksStopped: v.gum.tracks.length > 0 && v.gum.tracks.every((t) => t.stopped) }
    } finally { v.live.dispose() }

    // Assert
    assert.deepEqual(
      observed,
      { afterTap: { sessionOpen: false, playing: 0 }, micTracksStopped: true },
      'a mic tap during a pending attach ends the call (#20\'s explicit act); the mic allowed afterwards is released'
    )
  })
}

// #25 BY VOICE over an already-delivered tail: Live sends audio faster than real time, so its
// turnComplete often lands while the player still has seconds queued. The server then has no
// turn to interrupt, and speaking over the tail used to change nothing. The visitor's
// transcribed speech while the player is still sounding and no server turn is in flight cuts
// playback locally ('voice_local'); the gate stays idle so the answer plays.
const SPEECH_SHAPES = {
  'serverContent.inputTranscription': { serverContent: { inputTranscription: { text: 'Wait, show me Apptio.' } } },
  'root inputTranscription': { inputTranscription: { text: 'Wait, show me Apptio.' } }
}
for (const [shape, speech] of Object.entries(SPEECH_SHAPES)) {
  test(`speaking over a fully-delivered greeting tail stops it locally, and the answer plays (${shape})`, async () => {
    // Arrange — the greeting is fully delivered (turnComplete) but two chunks still sound.
    const v = await bootVoice({ permission: 'granted', mic: 'allow' })
    let observed = null
    try {
      await v.send({ serverContent: { modelTurn: { parts: [audioPart(), audioPart()] } } })
      await v.send({ serverContent: { turnComplete: true } })
      const playingBefore = v.audio.playing()

      // Act — the visitor speaks; Live transcribes it, then answers (no `interrupted`: there
      // was no server turn to interrupt).
      await v.send(speech)
      const playingAfterSpeech = v.audio.playing()
      await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })

      observed = { playingBefore, playingAfterSpeech, answerPlaying: v.audio.playing() }
    } finally { v.live.dispose() }

    // Assert
    assert.deepEqual(
      observed,
      { playingBefore: 2, playingAfterSpeech: 0, answerPlaying: 1 },
      'the visitor\'s voice must cut the sounding tail even after the server\'s turnComplete ' +
      '(invariant #25 by voice), without shutting the gate on the answer'
    )
  })
}

test('a late transcript of the visitor\'s question arriving while the answer streams does not cut the answer', async () => {
  // Arrange — Live's inputTranscription lags: the answer is already streaming (a server turn
  // in flight) when the last fragment of the question that prompted it lands.
  const v = await bootVoice({ permission: 'granted', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart(), audioPart()] } } })

    // Act
    await v.send({ serverContent: { inputTranscription: { text: ' about his work?' } } })

    observed = v.audio.playing()
  } finally { v.live.dispose() }

  // Assert — only an idle gate is the client's to cut; a turn in flight is the server's.
  assert.equal(observed, 3, 'the voice_local cut must not fire while a server turn is in flight')
})

test('two chips tapped in quick succession mid-greeting: the second chip\'s reply is not swallowed', async () => {
  // Arrange — the greeting is streaming.
  const v = await bootVoice({ permission: 'granted', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })

    // Act — chip 1, chip 2 at once. Live ends the greeting (interrupted + turnComplete), starts
    // on chip 1, cuts that for chip 2 (interrupted + turnComplete), then answers chip 2.
    v.live.sendUserText('Summarize Apptio (an IBM company) for me.')
    v.live.sendUserText('What was hard about Apptio (an IBM company)?')
    await settle()
    await v.send({ serverContent: { interrupted: true } })
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Apptio is' } } })
    await v.send({ serverContent: { interrupted: true } })
    await v.send({ serverContent: { turnComplete: true } })
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'The hard part was scale.' } } })

    observed = { chip2ReplyPlaying: v.audio.playing(), lastBubble: v.bubbleTexts('assistant').at(-1) }
  } finally { v.live.dispose() }

  // Assert
  assert.deepEqual(
    observed,
    { chip2ReplyPlaying: 1, lastBubble: 'The hard part was scale.' },
    'every abandoned turn ends at its own turnComplete; the gate must be open again for the last chip\'s reply'
  )
})

test('a chunk accepted just before an interrupt never starts playing after it (enqueue epoch)', async () => {
  // Arrange — the player's AudioContext starts suspended (autoplay policy), so enqueue is
  // parked on `await resume()` with a chunk the gate already accepted.
  const v = await bootVoice({ permission: 'prompt', mic: 'deny' })
  let startedAfterResume = null
  try {
    v.audio.suspendNext = true
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })

    // Act — the visitor barges in while that enqueue is parked, then the context resumes.
    await v.send({ serverContent: { interrupted: true } })
    for (const release of v.audio.resumeGates) release()
    await settle()
    startedAfterResume = v.audio.started()
  } finally { v.live.dispose() }

  // Assert
  assert.equal(
    startedAfterResume, 0,
    'ADR-0026 §3.3: interrupt() bumps the player epoch and a parked enqueue from an older epoch ' +
    'must not schedule — or a fragment of the cut-off sentence plays after the visitor stopped it'
  )
})

test('interruptAssistant is the single door: nothing else in chat-live.js cuts playback or cancels the gate', async () => {
  // Arrange — the source, comments stripped, with the door's own body cut out.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../js/chat-live.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const doorAt = src.indexOf('const interruptAssistant')
  const doorEnd = src.indexOf('\n  }\n', doorAt)
  const outsideDoor = src.slice(0, doorAt) + src.slice(doorEnd)
  const bindAt = outsideDoor.indexOf('export function bindChatLiveVoice')

  // Act — every remaining call that would cut the assistant off.
  const secondDoors = [
    ...outsideDoor.slice(bindAt).matchAll(/player\??\.interrupt\(\)|nextTurnGate\([^)]*'(?:interrupted|localInterrupt)'[^)]*\)/g)
  ].map((m) => m[0])

  // Assert
  assert.ok(bindAt >= 0 && doorAt > bindAt, 'harness: interruptAssistant must exist inside bindChatLiveVoice')
  assert.deepEqual(
    secondDoors, [],
    'invariant #25 / ADR-0026 §3.1: every cut goes through interruptAssistant(reason) — a second ' +
    'door is how a new trigger forgets the gate (the tail keeps playing) or the player (it keeps talking)'
  )
})

test('a chip that cuts off a greeting already fully delivered still gets its reply played', async () => {
  // Arrange — Live delivers audio faster than real time: the greeting's turnComplete has
  // arrived while its audio is still queued and playing. No server turn is in flight.
  const v = await bootVoice({ permission: 'prompt', mic: 'allow' })
  let observed = null
  try {
    await v.send({ serverContent: { modelTurn: { parts: [audioPart(), audioPart()] } } })
    await v.send({ serverContent: { turnComplete: true } })

    // Act — the chip cuts the queued audio; the server answers with NO turnComplete in between.
    v.live.sendUserText('Summarize Apptio (an IBM company) for me.')
    await settle()
    const playingAfterChip = v.audio.playing()
    await v.send({ serverContent: { modelTurn: { parts: [audioPart()] }, outputTranscription: { text: 'Apptio is cost software.' } } })

    observed = { playingAfterChip, playingReply: v.audio.playing() }
  } finally { v.live.dispose() }

  // Assert
  assert.deepEqual(
    observed,
    { playingAfterChip: 0, playingReply: 1 },
    'a local cut on an idle gate must leave it OPEN (ADR-0026 §3.2): nothing re-opens a ' +
    'cancelled gate until the next turnComplete, which belongs to the chip\'s own reply — so a ' +
    'naive cancel here drops every chunk of the answer the visitor just asked for'
  )
})
