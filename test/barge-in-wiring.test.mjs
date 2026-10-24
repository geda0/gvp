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
  const gum = { calls: 0 }

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
        const tracks = [{ stop () {} }]
        return { getTracks: () => tracks }
      }
    }
  })
  defineGlobal('AudioContext', audio.Ctx)
  defineGlobal('WebSocket', makeWebSocketClass(sockets))
  defineGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ websocketUrl: 'wss://chat.test/r', handshake: { setup: {} }, liveVoiceTransport: 'relay' }) }))
  const { bindChatLiveVoice } = await import('../js/chat-live.js?bargein=' + Math.random())
  const live = bindChatLiveVoice({
    messagesEl, statusEl: makeEl('p'), micButtons: [micButton], syncEmptyState () {}, scrollMessagesToBottom () {},
    setStatus () {}, getSessionId: () => 'barge-in', isTextPending: () => false, openPanel () {}, isPanelOpen: () => true, patchLiveUi () {}
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
const ACTS = {
  chip: { mic: () => 'allow', act: (v) => v.live.sendUserText('Summarize Apptio (an IBM company) for me.') },
  text: { mic: () => 'allow', act: (v) => v.live.sendUserText('What does he actually build?') },
  'mic tap': { mic: (path) => (path === 'cold' ? 'deny' : 'allow'), act: (v) => v.tapMic() }
}

for (const [pathName, path] of Object.entries(PATHS)) {
  for (const [actName, { mic, act }] of Object.entries(ACTS)) {
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
          { playingBefore, playingAfter: v.audio.playing() },
          { playingBefore: 2, playingAfter: 0 },
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
