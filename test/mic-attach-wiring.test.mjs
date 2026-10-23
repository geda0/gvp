import test from 'node:test'
import assert from 'node:assert/strict'

// M4 slice 14 (ADR-0017 §5.3): the WIRING of micAttachPlan, driven through the real
// bindChatLiveVoice closure over a fake WebSocket (helpers copied from
// voice-turn-gate-wiring.test.mjs). A pure-function test cannot say whether anything CALLS
// the plan - this file asks the browser-visible question: when does getUserMedia run?

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

test('permission prompt possible + greeting: no mic until the greeting finishes, then exactly one attach', async () => {
  const v = await bootVoice({ permission: 'prompt' })
  try {
    assert.equal(v.mic.calls, 0, 'a permission sheet must not open over the speaking greeting')
    await v.send({ serverContent: { turnComplete: true } })
    assert.equal(v.mic.calls, 1, 'the greeting\'s first turnComplete attaches the mic')
    await v.send({ serverContent: { turnComplete: true } })
    assert.equal(v.mic.calls, 1, 'a later turnComplete does not attach again')
  } finally { v.live.stopVoice?.() }
})

test('hanging up during the greeting cancels the deferred attach, including its 15 s fallback', async () => {
  // Capture the plan's fallback timer so the test can fire it after hang-up without waiting.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const fallbacks = new Map()
  let nextId = 1
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 15000) { const id = `fallback-${nextId++}`; fallbacks.set(id, fn); return id }
    return realSetTimeout(fn, ms, ...rest)
  }
  globalThis.clearTimeout = (id) => { if (fallbacks.has(id)) fallbacks.delete(id); else realClearTimeout(id) }
  try {
    const v = await bootVoice({ permission: 'prompt' })
    assert.equal(fallbacks.size, 1, 'the deferred attach armed exactly one fallback')
    const [armed] = fallbacks.values()
    v.live.stopVoice()
    await settle()
    assert.equal(fallbacks.size, 0, 'hanging up must clear the fallback timer')
    await armed() // even if a cleared timer still fired, it must not attach
    await settle()
    assert.equal(v.mic.calls, 0, 'no permission prompt for a session that no longer exists')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

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

test('stopVoiceInternal clears the deferred-attach timer (source pin for the 15 s fallback path)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../js/chat-live.js', import.meta.url), 'utf8')
  const stop = src.slice(src.indexOf('const stopVoiceInternal'), src.indexOf('const stopVoiceInternal') + 2500)
  assert.match(stop, /clearDeferredMicAttach\(\)/)
})
