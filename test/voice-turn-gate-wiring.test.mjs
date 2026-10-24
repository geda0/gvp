import test from 'node:test'
import assert from 'node:assert/strict'

// Is the turn gate actually WIRED into the live voice stream, or merely defined?
//
// js/voice-turn-gate.js + test/voice-turn-gate.test.mjs pin the gate's logic: `interrupted`
// cancels the turn so its whole tail is dropped, `turnComplete` is the boundary where the
// gate re-opens. Nothing pins the CALL SITES, so the gate can ship with zero callers and
// prod stays broken in all three ways the owner reported (screenshot, 2026-10-13):
//   1. the cut-off greeting kept arriving, SPLIT ACROSS EXTRA assistant bubbles;
//   2. the cut-off greeting AUDIO kept playing (the owner read it as "it lags");
//   3. the visitor's actual question was never answered.
//
// This repo has already paid for exactly this mistake. `starDepthFade` was defined,
// unit-tested AND mutation-tested, and never called — the full post-mortem is the comment
// block in test/starfield-depth-wiring.test.mjs. A test on a pure helper can never answer
// "does anything CALL it?", which is why that visual regression shipped behind a green
// suite. Same shape here, so this file is the deliberate complement:
//   voice-turn-gate.test.mjs        — is the turn-epoch logic right?
//   voice-turn-gate-wiring.test.mjs — is the turn-epoch logic USED, at BOTH sinks?
//
// The probe drives the real bindChatLiveVoice closure over a fake WebSocket through the
// real prod sequence. Greeting AUDIO comes first and its transcription has not landed yet
// (Live's outputTranscription lags its audio), which is why an early barge-in SPLITS the
// transcript instead of merely extending a bubble: the straggler arrives when there is no
// assistant bubble, so it opens a ghost one. Then `interrupted`, then the visitor's own
// transcription, then the dead greeting's tail in every wire shape the handler accepts
// (serverContent.outputTranscription, root-level outputTranscription, modelTurn.parts[].text,
// plus one late PCM part), then the turn boundary, then the real answer.
//
// That makes all three symptoms observable in one sequence: the transcript must end with
// exactly ONE assistant bubble (the answer — no ghost bubble for the greeting the visitor
// cut off), no PCM may be scheduled after the interrupt (the playback cursor that
// player.interrupt() just rewound must stay rewound), and the visitor's own words must
// survive — gating patchUserText as well would erase their question from the transcript,
// which is symptom 3 with extra steps.

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

async function bootVoiceSession() {
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
    // ADR-0028: a refused cold mic closes the call; 'granted' + a failing getUserMedia is the
    // remaining way to an open session with no live mic.
    permissions: { query: async () => ({ state: 'granted' }) },
    mediaDevices: {
      // Cold session: the mic is not granted, so the session stays open playing the
      // greeting with no mic attached — the exact state the prod report came from.
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

  const { bindChatLiveVoice } = await import('../js/chat-live.js?voicewire=' + Math.random())
  const live = bindChatLiveVoice({
    messagesEl,
    statusEl: makeEl('p'),
    micButtons: [micButton],
    syncEmptyState: () => {},
    scrollMessagesToBottom: () => {},
    setStatus: () => {},
    getSessionId: () => 'voice-wiring-session',
    isTextPending: () => false,
    openPanel: () => {},
    isPanelOpen: () => true,
    patchLiveUi: () => {}
  })
  assert.equal(
    typeof live.startVoice,
    'function',
    'harness: bindChatLiveVoice must hand back the voice handle, or this probe is blind'
  )

  void live.startVoice({ intent: 'cold' })
  await settle()
  const socket = sockets[0]
  assert.ok(socket, 'harness: starting voice must open a WebSocket, or this probe is blind')
  socket.onopen()
  await settle()
  socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) })
  await settle()

  return {
    live,
    scheduledAudio,
    send: async (payload) => {
      socket.onmessage({ data: JSON.stringify(payload) })
      await settle()
    },
    bubbleTexts: (role) => messagesEl.children
      .filter((node) => hasClass(node, `chat-msg--${role}`))
      .map((node) => node.querySelector('.chat-msg__text')?.textContent || '')
  }
}

test('an interrupted greeting leaves no ghost bubble and no late audio, and keeps the visitor\'s words', async () => {
  // Arrange — a live session with the greeting speaking: audio is flowing, its
  // transcription has not arrived yet, so there is no assistant bubble open.
  const voice = await bootVoiceSession()
  let observed = null

  try {
    await voice.send({ serverContent: { modelTurn: { parts: [audioPart()] } } })
    const greetingAudioChunks = voice.scheduledAudio.length

    // Act — the visitor cuts in; the server cancels the turn and then flushes the
    // dead greeting's tail (transcript AND audio) before the turn boundary.
    await voice.send({ serverContent: { interrupted: true } })
    await voice.send({ serverContent: { inputTranscription: { text: 'What does he actually build?' } } })
    await voice.send({ serverContent: { outputTranscription: { text: "Hi! I'm Marwan's AI assistant." } } })
    await voice.send({ outputTranscription: { text: ' What would you like to know' } })
    await voice.send({ serverContent: { modelTurn: { parts: [audioPart(), { text: ' about his work?' }] } } })
    const cancelledTurnAudioChunks = voice.scheduledAudio.length - greetingAudioChunks

    // The turn boundary, then the real answer to the question that was asked.
    await voice.send({ serverContent: { turnComplete: true } })
    await voice.send({ serverContent: { outputTranscription: { text: 'He builds AI agents.' } } })
    await voice.send({ serverContent: { turnComplete: true } })

    observed = {
      sessionOpen: voice.live.isSessionOpen(),
      greetingAudioChunks,
      cancelledTurnAudioChunks,
      assistantBubbles: voice.bubbleTexts('assistant'),
      userBubbles: voice.bubbleTexts('user')
    }
  } finally {
    voice.live.dispose()
  }

  // Assert
  assert.deepEqual(
    observed,
    {
      // Preconditions, so a dead harness can never pass as a working gate.
      sessionOpen: true,
      greetingAudioChunks: 1,
      // Symptom 2: the rewound playback cursor must stay rewound.
      cancelledTurnAudioChunks: 0,
      // Symptom 1: one bubble, the answer. A second entry here IS the ghost bubble.
      assistantBubbles: ['He builds AI agents.'],
      // Symptom 3's trap: the visitor's transcription is NOT the model's dead turn.
      userBubbles: ['What does he actually build?']
    },
    'js/chat-live.js must run the model-output sinks through the turn gate: the tail of a '
    + 'cancelled turn must reach NEITHER patchAssistantText (any extra assistantBubbles '
    + 'entry is the ghost bubble from the prod screenshot) NOR player.enqueue (any '
    + 'cancelledTurnAudioChunks is greeting audio scheduled after the barge-in) — while '
    + "patchUserText stays ungated, or the visitor's question disappears from the "
    + 'transcript. A defined-but-uncalled gate is the starfield depth-fade bug again.'
  )
})
