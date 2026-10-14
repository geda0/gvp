import test from 'node:test'
import assert from 'node:assert/strict'

// Does the turn gate LEAK across voice sessions?
//
// 2824aca landed the gate and 02a8482 wired it into the four model-output sinks. Both are
// correct WITHIN a session. But `turnGate` lives in the bindChatLiveVoice closure, and that
// closure is bound ONCE and outlives individual sessions — startVoice/stopVoice cycle the
// socket, not the closure. The gate is advanced to cancelled at `interrupted` and re-opened
// only at `turnComplete`, and `resetDraftState()` (which DOES reset its neighbour
// `turnInterrupted`) does not touch it.
//
// So: barge in, then tap voice off BEFORE the turn boundary arrives, and the gate is left
// CLOSED. The next session opens with a gate that drops everything — the first model turn's
// audio AND its transcript — until that turn's own `turnComplete`. The visitor taps the mic,
// the agent appears to say nothing at all, and there is no error anywhere.
//
// That is a regression INTRODUCED by the fix, and it is worse than the bug the fix was built
// for: a split transcript is visible and confusing, a silently muted greeting is invisible.
// "Tap off mid-barge-in" is not an exotic path either — it is the obvious thing to do when
// the agent is talking over you.
//
// The two existing gate tests cannot see this. voice-turn-gate.test.mjs drives the pure
// reducer, which has no concept of a session; voice-turn-gate-wiring.test.mjs drives exactly
// one session and always reaches a `turnComplete`. The leak only shows across a session
// boundary with no `turnComplete` in between, which is precisely the sequence below.

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

// One bound closure, many sessions — which is the whole point of this probe.
async function bootVoiceBinding() {
  const scheduledAudio = []
  const sockets = []
  const messagesEl = makeEl('ul')
  const micButton = makeEl('button')
  micButton.dataset = {}
  micButton.disabled = false
  micButton.addEventListener = () => {}
  micButton.removeEventListener = () => {}

  defineGlobal('document', {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
    addEventListener() {}
  })
  defineGlobal('window', {
    isSecureContext: true,
    location: {
      protocol: 'http:',
      hostname: 'portfolio.test',
      pathname: '/',
      hash: '',
      origin: 'http://portfolio.test'
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}
  })
  defineGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        const err = new Error('mic not granted in harness')
        err.name = 'NotAllowedError'
        throw err
      }
    }
  })
  defineGlobal('AudioContext', makeAudioContextClass(scheduledAudio))
  defineGlobal('WebSocket', makeWebSocketClass(sockets))
  defineGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      websocketUrl: 'wss://chat.test/api/live/relay/harness',
      handshake: { setup: {} },
      liveVoiceTransport: 'relay'
    })
  }))

  const { bindChatLiveVoice } = await import('../js/chat-live.js?gatereset=' + Math.random())
  const live = bindChatLiveVoice({
    messagesEl,
    statusEl: makeEl('p'),
    micButtons: [micButton],
    syncEmptyState: () => {},
    scrollMessagesToBottom: () => {},
    setStatus: () => {},
    getSessionId: () => 'voice-gate-reset-session',
    isTextPending: () => false,
    openPanel: () => {},
    isPanelOpen: () => true,
    patchLiveUi: () => {}
  })

  // Opens one session and returns a driver bound to ITS socket.
  const openSession = async () => {
    const before = sockets.length
    void live.startVoice({ intent: 'cold' })
    await settle()
    const socket = sockets[before]
    assert.ok(socket, 'harness: starting voice must open a fresh WebSocket, or this probe is blind')
    socket.onopen()
    await settle()
    socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) })
    await settle()
    return async (payload) => {
      socket.onmessage({ data: JSON.stringify(payload) })
      await settle()
    }
  }

  return {
    live,
    scheduledAudio,
    openSession,
    bubbleTexts: (role) => messagesEl.children
      .filter((node) => hasClass(node, `chat-msg--${role}`))
      .map((node) => node.querySelector('.chat-msg__text')?.textContent || '')
  }
}

test('a barge-in that ends the session does not mute the next session', async () => {
  const voice = await bootVoiceBinding()
  let observed = null

  try {
    // Arrange — session one: the greeting is speaking and the visitor cuts in.
    const sendToFirst = await voice.openSession()
    await sendToFirst({ serverContent: { modelTurn: { parts: [audioPart()] } } })
    const firstSessionAudio = voice.scheduledAudio.length
    await sendToFirst({ serverContent: { interrupted: true } })

    // Act — the visitor taps voice OFF while the agent is still mid-barge-in, so no
    // `turnComplete` ever arrives to re-open the gate. Then they start voice again.
    voice.live.stopVoice({ silent: true })
    await settle()

    const sendToSecond = await voice.openSession()
    const sessionOpen = voice.live.isSessionOpen()

    // The new session's very first model turn — audio, then its transcription.
    await sendToSecond({ serverContent: { modelTurn: { parts: [audioPart()] } } })
    await sendToSecond({ serverContent: { outputTranscription: { text: 'Hi again! What would you like to know?' } } })

    observed = {
      // Precondition: the second session really did come up, or this probe is blind.
      sessionOpen,
      // Precondition: the FIRST session's greeting audio did reach the player, so a
      // harness that schedules nothing at all cannot pass as a working gate.
      firstSessionAudio,
      // The regression: the new session's audio must be heard, not swallowed by a
      // gate the previous session left closed.
      secondSessionAudio: voice.scheduledAudio.length - firstSessionAudio,
      // And its transcript must render.
      assistantBubbles: voice.bubbleTexts('assistant')
    }
  } finally {
    voice.live.dispose()
  }

  assert.deepEqual(
    observed,
    {
      sessionOpen: true,
      firstSessionAudio: 1,
      secondSessionAudio: 1,
      assistantBubbles: ['Hi again! What would you like to know?']
    },
    'the turn gate leaked across sessions: an interrupt with no following turnComplete left '
    + 'it closed, so the NEXT session\'s first model turn was dropped — silently, which is '
    + 'worse than the split transcript the gate was built to fix. resetDraftState() resets '
    + 'turnInterrupted and must reset the gate too, since stopVoiceInternal is the only '
    + 'place a session can end without a turn boundary.'
  )
})
