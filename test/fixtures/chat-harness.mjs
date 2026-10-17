import assert from 'node:assert/strict'

// The stub-DOM harness that boots the REAL js/chat.js (and, through it, the real
// js/chat-live.js over a fake WebSocket).
//
// Extracted from test/site-events-never-stop-voice.test.mjs, which built it first, because
// every remaining M2 slice that asserts something about the chat panel needs the same boot:
// the tool-result contract (ADR-0015 §5), the stage chrome (§4.4), the live-session context
// notes (§7). Copying 250 lines of stub DOM per file is how the copies drift, and a drifted
// harness is a test that proves something about a DOM nobody ships.
//
// WHY A STUB AND NOT jsdom: this repo has zero test dependencies (package.json), and the
// browser journey harness is deliberately the LAST slice of M2 (§11.6) rather than a
// prerequisite for any of it. The stub is small on purpose — it answers only the surface
// chat.js and chat-live.js actually touch.
//
// node --test collects everything under test/, so this file also shows up in the run as a
// zero-test entry. That is harmless and mildly useful: it is a free import-time smoke check.
//
// Every id lookup answers with a NODE, never null, so an unstubbed id cannot masquerade as a
// missing element and quietly change a branch. `closest` is the one exception: chat.js reads
// a null there as "no scroll container".

const DEAD_RECT = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }

function makeListeners() {
  const byType = new Map()
  return {
    add(type, fn) {
      if (typeof fn !== 'function') return
      if (!byType.has(type)) byType.set(type, [])
      byType.get(type).push(fn)
    },
    remove(type, fn) {
      const list = byType.get(type)
      if (!list) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    count(type) { return (byType.get(type) || []).length },
    fire(type, event) {
      const list = [...(byType.get(type) || [])]
      for (const fn of list) fn(event)
      return list.length
    }
  }
}

// Minimal DOM node: just the surface js/chat.js + js/chat-live.js touch. Every lookup
// answers with a node (never null) so an unstubbed id cannot masquerade as a missing
// element and quietly change a branch; `closest` is the one exception, since chat.js
// treats a null there as "no scroll container".
function makeEl(tag = 'div') {
  const classes = new Set()
  const queried = new Map()
  const events = makeListeners()
  const el = {
    tagName: String(tag).toUpperCase(),
    events,
    className: '',
    textContent: '',
    value: '',
    placeholder: '',
    title: '',
    type: '',
    hidden: true,
    disabled: false,
    readOnly: false,
    children: [],
    options: [],
    dataset: {},
    attrs: {},
    parent: null,
    parentElement: null,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    offsetWidth: 0,
    style: { setProperty() {}, removeProperty() {} },
    setAttribute(name, value) { el.attrs[name] = String(value) },
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null },
    removeAttribute(name) { delete el.attrs[name] },
    toggleAttribute(name, on) {
      if (on) el.attrs[name] = ''
      else delete el.attrs[name]
      return Boolean(on)
    },
    appendChild(child) {
      child.parent = el
      child.parentElement = el
      el.children.push(child)
      return child
    },
    append(...kids) { for (const k of kids) el.appendChild(k) },
    replaceChildren(...kids) {
      el.children.length = 0
      for (const k of kids) el.appendChild(k)
    },
    insertBefore(child) { return el.appendChild(child) },
    remove() {
      const parent = el.parent
      if (!parent) return
      const at = parent.children.indexOf(el)
      if (at >= 0) parent.children.splice(at, 1)
      el.parent = null
      el.parentElement = null
    },
    contains() { return false },
    closest() { return null },
    matches() { return false },
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, makeEl('div'))
      return queried.get(selector)
    },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { ...DEAD_RECT } },
    scrollTo() {},
    focus() {},
    blur() {},
    addEventListener(type, fn) { events.add(type, fn) },
    removeEventListener(type, fn) { events.remove(type, fn) },
    dispatchEvent(event) {
      events.fire(String(event?.type || ''), event)
      return true
    }
  }
  el.classList = {
    add(cls) { classes.add(cls) },
    remove(cls) { classes.delete(cls) },
    toggle(cls, on) {
      const want = on === undefined ? !classes.has(cls) : Boolean(on)
      if (want) classes.add(cls)
      else classes.delete(cls)
      return want
    },
    contains(cls) { return classes.has(cls) }
  }
  return el
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

const settle = async (turns = 12) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
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
      this.closeCalls = 0
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this.onclose = null
      sockets.push(this)
    }
    send(payload) { this.sent.push(payload) }
    close() {
      this.closeCalls += 1
      this.readyState = 3
    }
  }
}

// Boots the real js/chat.js against the stub DOM and brings a real live voice session up
// over a fake WebSocket: open the panel, start voice cold (the mic is NOT granted, so the
// session stays open with no mic attached — one of the real prod states), then let
// setupComplete land, which is what makes isSessionOpen() true and the teardown at
// js/chat.js:902-909 reachable.
async function bootChatWithLiveVoice({ tag = 'harness', voice = true, hash = '' } = {}) {
  const sockets = []
  const byId = new Map()
  const docEvents = makeListeners()
  const winEvents = makeListeners()

  const getEl = (id) => {
    if (!byId.has(id)) byId.set(id, makeEl('div'))
    return byId.get(id)
  }

  defineGlobal('document', {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    activeElement: makeEl('div'),
    visibilityState: 'visible',
    getElementById: getEl,
    createElement: (tag) => makeEl(tag),
    // No <meta> tags: site-config.js resolves both API bases to '' on a non-local host,
    // which keeps every network call in this file inside the stubs.
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => docEvents.add(type, fn),
    removeEventListener: (type, fn) => docEvents.remove(type, fn)
  })
  // A gtag spy, because trackEvent's first-party mirror (js/site-events.js) buffers into a
  // module-private array and flushes to an events API that resolves to '' in here. gtag is
  // the only observable analytics surface from a test, and js/analytics.js:6-8 only needs it
  // to be a function on window.
  const gtagCalls = []
  const location = {
    protocol: 'http:',
    hostname: 'portfolio.test',
    pathname: '/',
    search: '',
    // The URL the page LOADS at. initNavigation's boot read of it is what writes the
    // starting section (origin 'system'), so a test that wants to start somewhere other
    // than home sets it here rather than calling setSection before the boot — a pre-boot
    // write is simply overwritten by that read, which is the real behaviour.
    hash,
    origin: 'http://portfolio.test'
  }
  defineGlobal('window', {
    isSecureContext: true,
    gtag: (...args) => { gtagCalls.push(args) },
    location,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    scrollTo () {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (type, fn) => winEvents.add(type, fn),
    removeEventListener: (type, fn) => winEvents.remove(type, fn),
    dispatchEvent: (event) => {
      winEvents.fire(String(event?.type || ''), event)
      return true
    }
  })
  // js/navigation.js writes the URL through history, so the stub has to move the same
  // `location` object the modules read back.
  defineGlobal('history', {
    replaceState (_state, _title, url) {
      if (typeof url === 'string') location.hash = url.startsWith('#') ? url : ''
    }
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
  defineGlobal('AudioContext', class FakeAudioContext {
    constructor() {
      this.sampleRate = 24000
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
    }
    async resume() {}
    async close() {}
    createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel() {} } }
    createBufferSource() { return { buffer: null, onended: null, connect() {}, stop() {}, start() {} } }
  })
  defineGlobal('WebSocket', makeWebSocketClass(sockets))
  // js/chat.js constructs one to drive the router; without it the home branch throws.
  defineGlobal('HashChangeEvent', class FakeHashChangeEvent {
    constructor(type, init = {}) {
      this.type = type
      this.oldURL = init.oldURL || ''
      this.newURL = init.newURL || ''
    }
  })
  defineGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0))
  defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id))
  // Every request the page makes is RECORDED, not just stubbed. The live-session POST
  // happens during boot, so a test that installed its own fetch afterwards could never see
  // it — and a test that installed one before boot had it overwritten right here.
  const fetchCalls = []
  defineGlobal('fetch', async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        websocketUrl: 'wss://chat.test/api/live/relay/no-site-kill',
        handshake: { setup: {} },
        liveVoiceTransport: 'relay'
      })
    }
  })

  const chat = await import('../../js/chat.js?' + tag + '=' + Math.random())
  const api = chat.initChat()
  assert.ok(
    api,
    'harness: initChat() returned null, so none of the production code under test ran'
  )
  assert.equal(
    typeof api.liveVoice?.stopVoice,
    'function',
    'harness: initChat() must expose the live voice handle, or the spy cannot sit in the call path'
  )

  // The ROUTER, in the same order js/app.js wires it (chat first, so the first
  // navigateByHash sync reaches the real launcher impl). It is not optional any more:
  // navigate_to_section goes through js/navigation.js's requestNavigation, which exists only
  // once initNavigation has run — routing moved out of js/chat.js so that resolving a
  // section, moving the URL and labelling the store write all happen in one place
  // (ADR-0015 §5.1, §9.4).
  // NOT cache-busted, unlike chat.js above. The busted chat.js resolves its own
  // `./navigation.js` import to the UNBUSTED specifier, so busting it here would hand the
  // test a second module instance whose requestNavigationImpl hook nothing ever reaches —
  // which looks exactly like the byte-exact bug this milestone just fixed.
  const nav = await import('../../js/navigation.js')
  nav.initNavigation({ onStateChange: (section) => { chat.syncChatLaunchers(section) } })

  // The CONTACT FORM, for the same reason: `open_contact_form` reaches
  // js/contact.js's openContactDialog, which is a no-op until initContactForm has assigned
  // its impl — so without this the tool runs, reports success, and contactOpen stays false.
  // Not cache-busted, same argument as navigation above.
  const contact = await import('../../js/contact.js')
  contact.initContactForm()
  await settle()

  // `voice: false` stops here, with the modules initialised and NOTHING opened — the state
  // the page is in between load and the visitor's first tap. Bringing a live session up
  // requires openPanel (that is how startVoice gets a panel to render into), so a caller
  // that wants the untouched boot state cannot also have voice, and must not pretend to:
  // closing the panel afterwards to "get back" to closed is a different state, and a row
  // asserting the boot contract against it proves nothing.
  if (!voice) {
    return { chat, nav, contact, api, socket: null, sockets, getEl, byId, docEvents, winEvents, gtagCalls, fetchCalls }
  }

  api.openPanel()
  await settle()
  void api.liveVoice.startVoice({ intent: 'cold' })
  await settle()
  const socket = sockets[0]
  assert.ok(socket, 'harness: starting voice must open a WebSocket, or this probe is blind')
  socket.onopen()
  await settle()
  socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) })
  await settle()

  return { chat, nav, contact, api, socket, sockets, getEl, byId, docEvents, winEvents, gtagCalls, fetchCalls }
}
export { DEAD_RECT, makeListeners, makeEl, defineGlobal, settle, makeWebSocketClass, bootChatWithLiveVoice }
