import test from 'node:test'
import assert from 'node:assert/strict'

// Can a site-layout change end a live voice conversation?
//
// Project invariant #20 (ADR-0015 §8) says never: "A site-layout or navigation change
// never terminates a live voice session. No path reachable from a siteState write, a
// stage transition, a navigation, a project dialog, or the contact dialog may call
// stopVoice or close the live WebSocket." Today every one of those paths does, so this
// file is that invariant's pin — landed as M2's FIRST slice (ADR-0015 §11.3) instead of
// inside the browser journey harness the plan buried it in, because it is the one
// property of the milestone that silently restores the whole defect if it regresses.
//
// THE DEFECT, measured end to end (ADR-0015 §9.1):
//   js/app.js:243-245        if (state === 'portfolio' || state === 'labs') collapseChatDialog()
//   js/chat.js:239-241       collapseChatDialog() -> collapseChat()
//   js/chat.js:1020          collapseChat = () => closePanel({ restoreFocus: false, immediate: true })
//   js/chat.js:983-988       immediate -> snapClose({ restoreFocus })
//   js/chat.js:902-909       session open -> liveVoice?.stopVoice?.({ silent: true })   <-- the kill
//   js/chat-live.js:762-778  detach handlers, ws = null, w.close()
// Two more emitters reach the identical closePanel through an event: js/projects.js:228
// (a project dialog opening) and js/contact.js:77 (the contact dialog opening) both
// dispatch 'gvp:site-chat-collapse', whose only listener is js/chat.js:1433. So the
// assistant's own navigate_to_section tore down the very session that had just promised
// the move, and a visitor tapping a project card did the same thing to them.
//
// TWO CORRECTIONS TO THE PLAN decide this test's shape; without them a version of this
// test passes vacuously and proves nothing:
//
//  1. "on every navigation" is FALSE. The app.js call is GUARDED by
//     `state === 'portfolio' || state === 'labs'`, so navigating HOME never collapsed
//     anything. A journey asserting "navigation never kills voice" that exercised only
//     -> home would have been green against the broken code. Hence portfolio and labs
//     are separate rows here, and the home row is labelled for what it honestly is: a
//     CONTROL that is already green today. It is not dead weight — it drives
//     syncChatLaunchers(section), the one chat entry point app.js:246 calls on EVERY
//     navigation, home included, and invariant #20 covers that path too.
//
//  2. Not covered here, deliberately: open_contact_form and navigate_to_section fail
//     DIFFERENTLY (ADR-0015 §9.3 c1). openContactFromChat (js/chat.js:1023) calls
//     closePanel SYNCHRONOUSLY, so chat-live's `ws` closure variable is already null
//     when the send-guard at js/chat-live.js:997 runs and the toolResponse is DROPPED;
//     navigate_to_section assigns window.location.hash, which queues hashchange as a
//     task, so the toolResponse IS sent and then the socket dies mid-sentence. Those are
//     two distinct failures about the TOOL RESULT, not about voice surviving a site
//     event, and merging them into this file would blur both. They get their own slices.
//
// WHY THIS HARNESS. The spy is injected by replacing `stopVoice` on the live-voice handle
// that initChat() hands back (js/chat.js:1618 exposes the very object built at :1543).
// chat.js reads that property at each call site (`liveVoice?.stopVoice?.(...)`), so the
// spy sits INSIDE the production call path rather than beside it. The alternative —
// asserting the panel collapsed, or counting DOM writes — would have pinned today's
// chrome, and ADR-0015 §4.3 is about to legitimately change it (a `navigate` from `modal`
// becomes `docked`/`minimized`, i.e. the panel stays visible and only yields the stage).
// So this file asserts the one thing that must hold in EVERY stage: the session lives.
// The spy deliberately does NOT delegate to the real stopVoice, so a row that trips the
// bug cannot disarm the rows after it by actually killing the session — every row faces
// the same live session. The socket's own close() is counted too, because the invariant
// forbids closing the WebSocket by any route, not just through the public stopVoice.
// Session + socket come from the real js/chat-live.js driven over a fake WebSocket, the
// technique test/voice-turn-gate-wiring.test.mjs already uses; globals are installed
// before a cache-busted import, as in test/starfield-depth-wiring.test.mjs.
//
// PRECONDITIONS ARE PART OF THE SNAPSHOT, and that is not decoration. A spy stuck at zero
// because nothing ever ran is the failure mode that makes this kind of test worthless,
// and this repo has already shipped a defined-but-never-called helper behind a green
// suite (the post-mortem is the comment block in test/starfield-depth-wiring.test.mjs).
// So the snapshot also carries: the session was open before the first site event and
// after the last; the panel was open each time a site event fired (closePanel returns
// early at js/chat.js:984 when it is not, which would eat the stimulus silently);
// 'gvp:site-chat-collapse' has a listener at all; an explicit visitor act (Start over,
// js/chat.js:1044-1049 — named in invariant #20 as a path that MAY end voice) DOES reach
// the spy; and a real stopVoice DOES close the fake socket.
//
// WHAT THIS TEST CANNOT CATCH, stated so nobody over-reads a green:
//  - It drives the two calls js/app.js:243-246 makes, not app.js itself. A NEW chat call
//    added to that navigation callback is invisible here; that is the journey harness's
//    job at the end of M2 (ADR-0015 §11.6).
//  - When ADR-0015 §3.6 removes 'gvp:site-chat-collapse' and §3.2 deletes the app.js
//    call, this file must be RE-POINTED at the replacement writers (setSection /
//    setProject / setContactOpen and the stage reducer) — NOT deleted. The invariant
//    outlives the seam. It fails loudly on removal (missing export, zero listeners)
//    rather than going quietly green, which is the intended behaviour.

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
async function bootChatWithLiveVoice() {
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
    addEventListener: (type, fn) => winEvents.add(type, fn),
    removeEventListener: (type, fn) => winEvents.remove(type, fn),
    dispatchEvent: (event) => {
      winEvents.fire(String(event?.type || ''), event)
      return true
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
  defineGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0))
  defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id))
  defineGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      websocketUrl: 'wss://chat.test/api/live/relay/no-site-kill',
      handshake: { setup: {} },
      liveVoiceTransport: 'relay'
    })
  }))

  const chat = await import('../js/chat.js?sitevoice=' + Math.random())
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

  return { chat, api, socket, getEl, winEvents }
}

const NAV_PORTFOLIO = 'navigate -> portfolio (js/app.js:243-246)'
const NAV_LABS = 'navigate -> labs (js/app.js:243-246)'
const NAV_HOME = 'navigate -> home (js/app.js:246 only; CONTROL, green today)'
const DIALOG_COLLAPSE = 'project or contact dialog opens (js/projects.js:228 / js/contact.js:77)'

test('no navigation or site dialog can end a live voice session', async (t) => {
  // Arrange — a live voice session, panel open, with a spy standing exactly where
  // js/chat.js calls stopVoice.
  const { chat, api, socket, getEl, winEvents } = await bootChatWithLiveVoice()
  t.after(() => api.disposeChatLiveVoice())

  const realStopVoice = api.liveVoice.stopVoice
  const stopVoiceCalls = []
  api.liveVoice.stopVoice = (opts) => { stopVoiceCalls.push(opts || {}) }

  // Exactly what js/app.js's onStateChange does per section, and exactly what the two
  // dialog emitters dispatch. No branching here — the table IS the production mapping.
  const siteEvents = [
    [NAV_PORTFOLIO, () => {
      chat.collapseChatDialog()
      chat.syncChatLaunchers('portfolio')
    }],
    [NAV_LABS, () => {
      chat.collapseChatDialog()
      chat.syncChatLaunchers('labs')
    }],
    [NAV_HOME, () => {
      chat.syncChatLaunchers('home')
    }],
    [DIALOG_COLLAPSE, () => winEvents.fire('gvp:site-chat-collapse', { type: 'gvp:site-chat-collapse' })]
  ]

  const voiceSessionOpenBeforeSiteEvents = api.liveVoice.isSessionOpen()
  const siteChatCollapseListeners = winEvents.count('gvp:site-chat-collapse')
  const panelOpenWhenSiteEventFired = {}
  const stopVoiceCallsBySiteEvent = {}

  // Act — every site event, each against the same open panel and the same live session.
  for (const [name, fireSiteEvent] of siteEvents) {
    api.openPanel()
    await settle()
    panelOpenWhenSiteEventFired[name] = api.isOpen()
    stopVoiceCalls.length = 0
    fireSiteEvent()
    await settle()
    stopVoiceCallsBySiteEvent[name] = stopVoiceCalls.length
  }

  const observed = {
    voiceSessionOpenBeforeSiteEvents,
    siteChatCollapseListeners,
    panelOpenWhenSiteEventFired,
    stopVoiceCallsBySiteEvent,
    liveSocketCloseCallsDuringSiteEvents: socket.closeCalls,
    voiceSessionOpenAfterSiteEvents: api.liveVoice.isSessionOpen()
  }

  // Two positive controls: the spy really is in a production call path, and the socket
  // probe really can see a close. Without these, "zero calls" could just mean "dead probe".
  stopVoiceCalls.length = 0
  const startOverEl = makeEl('button')
  startOverEl.dataset.action = 'start-over'
  const startOverHandlers = getEl('chatDialog').events.fire('click', {
    target: { closest: (selector) => (selector === '[data-action]' ? startOverEl : null) }
  })
  await settle()
  observed.visitorStartOverHandlers = startOverHandlers
  observed.stopVoiceCallsOnVisitorStartOver = stopVoiceCalls.length

  realStopVoice({ silent: true })
  await settle()
  observed.liveSocketClosedByAnExplicitStopVoice = socket.closeCalls > 0

  // Assert
  assert.deepEqual(
    observed,
    {
      // Preconditions: the probe is live.
      voiceSessionOpenBeforeSiteEvents: true,
      siteChatCollapseListeners: 1,
      panelOpenWhenSiteEventFired: {
        [NAV_PORTFOLIO]: true,
        [NAV_LABS]: true,
        [NAV_HOME]: true,
        [DIALOG_COLLAPSE]: true
      },
      // Invariant #20: a site event may never end the conversation.
      stopVoiceCallsBySiteEvent: {
        [NAV_PORTFOLIO]: 0,
        [NAV_LABS]: 0,
        [NAV_HOME]: 0,
        [DIALOG_COLLAPSE]: 0
      },
      liveSocketCloseCallsDuringSiteEvents: 0,
      voiceSessionOpenAfterSiteEvents: true,
      // Positive controls.
      visitorStartOverHandlers: 1,
      stopVoiceCallsOnVisitorStartOver: 1,
      liveSocketClosedByAnExplicitStopVoice: true
    },
    'project invariant #20 (ADR-0015 §8): a site-layout or navigation change must never '
    + 'terminate a live voice session. Any non-zero entry in stopVoiceCallsBySiteEvent is '
    + 'the ADR-0015 §9.1 teardown still live — a site event reaching snapClose '
    + '(js/chat.js:902-909), which kills the session the assistant just promised to act in. '
    + 'The portfolio and labs rows are the guarded js/app.js:243 call; the home row is the '
    + 'control that was always green and is NOT evidence. A non-zero '
    + 'liveSocketCloseCallsDuringSiteEvents means some other path closed the live socket '
    + 'without going through stopVoice. If instead a PRECONDITION is wrong, fix the harness '
    + 'before reading anything else: zero stopVoice calls from a dead probe proves nothing, '
    + 'which is the exact mistake behind the starfield depth-fade regression.'
  )
})
