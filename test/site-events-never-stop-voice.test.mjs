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
// early at js/chat.js:984 when it is not, which would eat the stimulus silently); an
// explicit visitor act (Start over, js/chat.js:1044-1049 — named in invariant #20 as a path
// that MAY end voice) DOES reach the spy; and a real stopVoice DOES close the fake socket.
//
// WHAT THIS TEST CANNOT CATCH, stated so nobody over-reads a green:
//  - It drives the store writes the site modules make, not those modules. That they make
//    them is test/site-state-writers.test.mjs's job; that js/app.js adds no new chat call
//    of its own is the journey harness's, at the end of M2 (ADR-0015 §11.6).
//  - The old listener-count precondition is gone with the event it counted. Its job — "the
//    stimulus reached something" — now belongs to panelOpenWhenSiteEventFired plus the
//    stage assertions in test/chat-stage-wiring.test.mjs, which check that each of these
//    writes actually MOVES the panel rather than passing through unnoticed. A version of
//    this file with no such check would go quietly green against a chat that had simply
//    stopped subscribing.

// The stub-DOM boot lives in test/fixtures/chat-harness.mjs — it was built here first and
// moved out once the later M2 slices needed the same boot. The notes on why it is a stub
// rather than jsdom, and on every-lookup-answers-with-a-node, travelled with it.
import { makeEl, settle, bootChatWithLiveVoice, defineGlobal } from './fixtures/chat-harness.mjs'

// RE-POINTED at the replacement writers, exactly as the note above says this file must be
// when ADR-0015 §3.6 removes the event. The invariant outlives the seam: what used to be
// `chat.collapseChatDialog()` and a 'gvp:site-chat-collapse' dispatch is now a write to
// js/site-state.js, which the chat reads and reduces. The rows are the same site events.
const NAV_WORK = 'setSection(portfolio) — js/navigation.js applySection'
const NAV_LABS = 'setSection(labs) — js/navigation.js applySection'
const NAV_HOME = 'setSection(home) — CONTROL: was never guarded, so always green'
const PROJECT_OPEN = 'setProject(...) — js/projects.js openDialog'
const CONTACT_OPEN = 'setContactOpen(true) — js/contact.js openDialog'
const RETURN_PATH = 'the dialogs closing again — setContactOpen(false) + setProject(null)'

test('no navigation or site dialog can end a live voice session', async (t) => {
  // Arrange — a live voice session, panel open, with a spy standing exactly where
  // js/chat.js calls stopVoice.
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, socket, getEl } = await bootChatWithLiveVoice({ tag: 'sitevoice' })
  t.after(() => api.disposeChatLiveVoice())

  const realStopVoice = api.liveVoice.stopVoice
  const stopVoiceCalls = []
  api.liveVoice.stopVoice = (opts) => { stopVoiceCalls.push(opts || {}) }

  // Exactly the writes the site modules make. No branching here — the table IS the
  // production mapping, and `origin: 'agent'` on two rows is the case the whole milestone is
  // about: the assistant's own navigate_to_section / open_contact_form used to tear down the
  // session that had just promised the action.
  const siteEvents = [
    [NAV_WORK, () => siteState.setSection('portfolio', { origin: 'agent' })],
    [NAV_LABS, () => siteState.setSection('labs', { origin: 'visitor' })],
    [NAV_HOME, () => siteState.setSection('home', { origin: 'visitor' })],
    [PROJECT_OPEN, () => siteState.setProject(
      { id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })],
    [CONTACT_OPEN, () => siteState.setContactOpen(true, { origin: 'agent' })],
    [RETURN_PATH, () => {
      siteState.setContactOpen(false, { origin: 'visitor' })
      siteState.setProject(null, { origin: 'visitor' })
    }]
  ]

  const voiceSessionOpenBeforeSiteEvents = api.liveVoice.isSessionOpen()
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
      panelOpenWhenSiteEventFired: {
        [NAV_WORK]: true,
        [NAV_LABS]: true,
        [NAV_HOME]: true,
        [PROJECT_OPEN]: true,
        [CONTACT_OPEN]: true,
        [RETURN_PATH]: true
      },
      // Invariant #20: a site event may never end the conversation.
      stopVoiceCallsBySiteEvent: {
        [NAV_WORK]: 0,
        [NAV_LABS]: 0,
        [NAV_HOME]: 0,
        [PROJECT_OPEN]: 0,
        [CONTACT_OPEN]: 0,
        [RETURN_PATH]: 0
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

// ADR-0026 G2 negative: invariant #25 adds LOCAL interrupts for acts that address the
// assistant (a chip, a text turn, a mic tap). Navigating the site does not address it, so the
// session surviving is not enough — the assistant must keep TALKING while the visitor browses
// (M2's "keeps talking while I navigate"). A wider door that cut playback on any site event
// would leave every row of the test above green.
test('navigating the site or opening and closing a dialog does not stop the assistant talking', async (t) => {
  // Arrange — a live call with the assistant's audio playing; every source is recorded.
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'sitevoice-playback' })
  t.after(() => api.disposeChatLiveVoice())
  const sources = []
  defineGlobal('AudioContext', class RecordingAudioContext {
    constructor () { this.sampleRate = 24000; this.state = 'running'; this.currentTime = 0; this.destination = {} }
    async resume () {}
    async close () {}
    createBuffer (channels, length, rate) { return { duration: length / rate, copyToChannel () {} } }
    createBufferSource () {
      const src = { started: false, stopped: false, connect () {}, start () { src.started = true }, stop () { src.stopped = true } }
      sources.push(src)
      return src
    }
  })
  const playing = () => sources.filter((s) => s.started && !s.stopped).length
  socket.onmessage({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa('\u0000\u0001\u0000\u0002') } }] } } }) })
  await settle()
  const playingBefore = playing()

  // Act — scrolling to a section, opening a project dialog, closing it again.
  siteState.setSection('portfolio', { origin: 'visitor' })
  await settle()
  siteState.setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })
  await settle()
  siteState.setProject(null, { origin: 'visitor' })
  await settle()

  // Assert
  assert.deepEqual(
    { playingBefore, playingAfter: playing() },
    { playingBefore: 1, playingAfter: 1 },
    'a site event is not an act addressed to the assistant: it must not reach interruptAssistant'
  )
})
