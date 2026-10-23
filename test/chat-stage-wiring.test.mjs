import test from 'node:test'
import assert from 'node:assert/strict'

import { settle, bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'
import { stageChrome } from '../js/chat-stage.js'

// Does the chat actually YIELD THE STAGE, rather than being torn down or sitting on top?
//
// This is the milestone's claim, wired: js/chat.js subscribes to the store (ADR-0015 §3),
// feeds each change to the pure reducer (§4.3), and applies the chrome the reducer's stage
// names (§4.4). `gvp:site-chat-collapse` and js/app.js's collapseChatDialog() are gone —
// removed, not adapted (§3.6), because a surviving emitter still reaches snapClose and
// silently restores the §9.1 teardown.
//
// WHAT THIS FILE ADDS over the three that came before it:
//   test/chat-stage.test.mjs            the reducer's table, in isolation
//   test/site-state.test.mjs            the store's contract
//   test/site-state-writers.test.mjs    that the site modules write it
//   test/site-events-never-stop-voice   that nothing in that chain kills voice
// ...none of which can tell you the three are CONNECTED. A reducer with a perfect table
// that nobody calls is exactly the defect this repo already shipped once behind a green
// suite (the post-mortem is in test/starfield-depth-wiring.test.mjs). So every row here
// drives a REAL store write and reads the REAL dialog's attributes back.
//
// THE CHROME IS COMPARED AGAINST stageChrome, not against literals. A copy of the expected
// attributes here would be a second source of truth, and the one in the ADR would be the
// one that rots. The literals live in test/chat-stage.test.mjs, where the contract is the
// subject; here the question is only whether the DOM matches it.

const WIDE = 1280
const NARROW = 420

/** The DOM facts stageChrome's fields map onto, read back off the real elements. */
function readChrome (getEl) {
  const dialog = getEl('chatDialog')
  const panel = dialog.querySelector('.chat-dialog__panel')
  const backdrop = dialog.querySelector('.chat-dialog__backdrop')
  return {
    dialogHidden: Boolean(dialog.hidden),
    backdropHidden: Boolean(backdrop.hidden),
    scrollLock: document.body.classList.contains('chat-dialog-open'),
    ariaModal: panel.getAttribute('aria-modal'),
    // NO `|| 'none'` FALLBACK. It used to have one, and that defeated the assertion: an
    // UNSET pointerEvents reads as '' and the fallback turned that into exactly the value
    // the three yielded/closed stages expect — so deleting the line in js/chat.js that
    // applies it left the whole suite green while #chatDialog, which is `position: fixed;
    // inset: 0`, swallowed every click on the site. The ADR calls this the highest-value
    // assertion in the app half; it was reading a default.
    pointerEventsOnShell: dialog.style.pointerEvents
  }
}

/** stageChrome minus the two fields that are instructions rather than DOM state. */
function expectedChrome (stage) {
  const { moveFocus, ...rest } = stageChrome(stage)
  void moveFocus
  return rest
}

/**
 * THE HARNESS BOOTS WITH THE PANEL ALREADY OPEN. bootChatWithLiveVoice has to call
 * openPanel() to bring a live session up at all, so every test here starts at `modal` with
 * voice connected — which is the state most of them want. `startClosed` is for the two rows
 * that need a genuinely closed chat (that closePanel also stops voice is fine for those:
 * neither is about the session). Stating it rather than assuming it, because assuming it was
 * wrong: the first version of this file read `modal` as `closed` and read an openPanel()
 * no-op as a missing store write.
 */
async function boot (tag, width = WIDE, { startClosed = false, voice = true } = {}) {
  // RESET BEFORE BOOT, in that order, and it is load-bearing. The store is a module
  // singleton (§3.5) while each test gets a cache-busted js/chat.js, so without the reset:
  // every earlier test's chat instance is still subscribed and still writing chatStage, and
  // the store arrives holding the stage the previous test left — which made `closed` look
  // like `docked` and swallowed an `open -> modal` write as a same-value no-op. Resetting
  // AFTER the boot would drop the subscription initChat just made, and the panel would
  // stop reacting to the site entirely.
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()

  const h = await bootChatWithLiveVoice({ tag, voice })
  window.innerWidth = width
  window.matchMedia = (query) => ({
    // The one media query the stage cares about. 768px is the shipped breakpoint
    // (css/chat.css, and CLAUDE.md's 767px/1024px convention).
    matches: /min-width/.test(query) ? width >= 768 : width < 768,
    addEventListener () {},
    removeEventListener () {}
  })
  if (startClosed) {
    h.api.closePanelImmediate()
    await settle()
    assert.equal(
      siteState.getSiteState().chatStage, 'closed',
      'harness: startClosed must actually land on closed, or the row below proves nothing'
    )
  }
  return { ...h, siteState }
}

test('the DOM agrees with the stage from boot, before anything is opened', async (t) => {
  // MEASURED in a browser: index.html:300 hard-codes aria-modal="true" on the panel and
  // nothing sets data-chat-stage until the first openPanel. So between load and first open,
  // the markup claimed a modal dialog that did not exist — harmless while [hidden] keeps it
  // out of the accessibility tree, but it means the CSS has no stage to style and any code
  // reading the attribute is reading a stale literal. The stage is a contract; it should
  // hold from the first frame, not from the first interaction.
  // voice:false, so NOTHING has been opened — this is the page between load and the first
  // tap. Booting with voice and then closing would be a different state entirely, and a row
  // asserting the boot contract against it is green no matter what init does. (It was: the
  // first version of this row used startClosed and passed before the fix existed.)
  const { api, getEl, siteState } = await boot('stage-boot', WIDE, { voice: false })
  t.after(() => api.disposeChatLiveVoice())

  assert.equal(api.isOpen(), false, 'harness: nothing may have been opened')
  assert.equal(siteState.getSiteState().chatStage, 'closed')
  assert.equal(
    getEl('chatDialog').dataset.chatStage, 'closed',
    'data-chat-stage must be set from init — it is the hook every stage rule in css/chat.css ' +
    'is written against, and an unset one silently falls back to the modal styling'
  )
  assert.deepEqual(readChrome(getEl), expectedChrome('closed'))
})

test('a navigation while the panel is modal yields the stage instead of closing it', async (t) => {
  const { api, getEl, siteState } = await boot('stage-nav', WIDE)
  t.after(() => api.disposeChatLiveVoice())

  assert.equal(
    siteState.getSiteState().chatStage, 'modal',
    'the panel the harness opened must have written its stage: chatStage is js/chat.js\'s ' +
    'field to write (§3.2), and §7\'s live note reads it'
  )
  // The MODAL row, which the file did not have. Without it every chrome comparison here is
  // against a stage whose pointerEventsOnShell is 'none' — the same value an unset property
  // reads as — so nothing in the file could tell "applied correctly" from "never applied".
  assert.deepEqual(
    readChrome(getEl), expectedChrome('modal'),
    'a modal panel OWNS the viewport: pointer events on, backdrop shown, scroll locked'
  )

  // The visitor navigates. This is the write js/navigation.js makes.
  siteState.setSection('portfolio', { origin: 'visitor' })
  await settle()

  assert.equal(
    siteState.getSiteState().chatStage, 'docked',
    'wide + navigate from modal = docked (§4.3). The shipped behaviour was closePanel, i.e. ' +
    'the conversation left the screen the moment the visitor moved — and on the agent\'s own ' +
    'navigate_to_section, the moment it promised to move them'
  )
  assert.equal(
    api.isOpen(), true,
    'and the panel must still be OPEN. A docked stage that reports closed would make every ' +
    'isOpen() guard in js/chat.js — closePanel\'s early return at :984, the launcher sync — ' +
    'disagree with what is on screen'
  )
  assert.deepEqual(
    readChrome(getEl), expectedChrome('docked'),
    'the applied chrome must be exactly stageChrome(docked) (§4.4). The backdrop row is the ' +
    'load-bearing one: it is a real inset:0 element (index.html:299), so FADING it instead ' +
    'of hiding it leaves the site visually operable and functionally dead, with this suite ' +
    'still green'
  )
})

test('on a narrow viewport the same navigation minimises instead of docking', async (t) => {
  const { api, getEl, siteState } = await boot('stage-narrow', NARROW)
  t.after(() => api.disposeChatLiveVoice())

  siteState.setSection('labs', { origin: 'agent' })
  await settle()

  assert.equal(
    siteState.getSiteState().chatStage, 'minimized',
    'narrow has no room for a docked card beside the content, so the yielded stage is the ' +
    'pill (§4.3). ctx.wide is INJECTED into the reducer — this row is what proves js/chat.js ' +
    'is the one reading the viewport, which is why the reducer stayed pure'
  )
  assert.deepEqual(readChrome(getEl), expectedChrome('minimized'))
})

test('the contact form minimises the chat at EVERY width, and gives the stage back', async (t) => {
  const { api, getEl, siteState } = await boot('stage-contact', WIDE)
  t.after(() => api.disposeChatLiveVoice())

  siteState.setContactOpen(true, { origin: 'agent' })
  await settle()

  assert.equal(
    siteState.getSiteState().chatStage, 'minimized',
    'contact-open minimises even on wide (§4.3). The contact dialog is itself aria-modal ' +
    'and binds Escape (js/contact.js); a docked chat card beside it competes for the same ' +
    'key and the same focus ring'
  )
  assert.deepEqual(readChrome(getEl), expectedChrome('minimized'))

  // The RETURN PATH, which the plan omits entirely.
  siteState.setContactOpen(false, { origin: 'visitor' })
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'docked',
    'closing the form must hand the stage back. Without the return path a visitor who opens ' +
    'the form and closes it is left with a pill, and an assistant mid-sentence has nowhere ' +
    'to speak from'
  )
  assert.deepEqual(readChrome(getEl), expectedChrome('docked'))
})

test('a project dialog yields and returns, and a site event never reopens a closed chat', async (t) => {
  const { api, getEl, siteState } = await boot('stage-project', WIDE, { startClosed: true })
  t.after(() => api.disposeChatLiveVoice())

  // A visitor who has NEVER opened the chat must not acquire one by tapping a card.
  siteState.setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'closed',
    'closed is ABSORBING for every site event (§4.3) — the single most likely way to turn ' +
    '"the assistant yields the stage" into "the assistant is always on screen"'
  )
  assert.equal(api.isOpen(), false, 'and no panel may appear')
  assert.deepEqual(readChrome(getEl), expectedChrome('closed'))

  siteState.setProject(null, { origin: 'visitor' })
  await settle()
  api.openPanel()
  await settle()
  siteState.setProject({ id: 'gvp', title: 'This site' }, { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'docked')

  siteState.setProject(null, { origin: 'visitor' })
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'docked',
    'closing a project dialog from docked leaves it docked — a dialog closing must never ' +
    'DEMOTE an already-visible panel'
  )
})

test('a stage change never ends the live voice session', async (t) => {
  // Invariant #20, re-pointed at the replacement seam exactly as
  // test/site-events-never-stop-voice.test.mjs says it must be when §3.6 removes the event:
  // the writers, not the event. That file drives the old chain; this one drives the new one.
  const { api, siteState } = await boot('stage-voice', WIDE)
  t.after(() => api.disposeChatLiveVoice())

  assert.equal(
    api.liveVoice.isSessionOpen(), true,
    'harness: the live session must be up before this proves anything'
  )

  const stopCalls = []
  api.liveVoice.stopVoice = (opts) => { stopCalls.push(opts || {}) }

  siteState.setSection('portfolio', { origin: 'agent' })
  siteState.setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })
  siteState.setContactOpen(true, { origin: 'agent' })
  siteState.setContactOpen(false, { origin: 'visitor' })
  siteState.setProject(null, { origin: 'visitor' })
  siteState.setSection('home', { origin: 'visitor' })
  await settle()

  assert.deepEqual(
    stopCalls, [],
    'every one of those is a site-layout change, and invariant #20 forbids all of them from ' +
    'ending the conversation. A non-empty list means a stage transition is routing through ' +
    'closePanel/snapClose again instead of applying chrome'
  )
  assert.equal(api.liveVoice.isSessionOpen(), true, 'the session must still be open')
})

test('the stage is written by chat.js with an honest origin', async (t) => {
  const { api, siteState } = await boot('stage-origin', WIDE, { startClosed: true })
  t.after(() => api.disposeChatLiveVoice())

  const stageWrites = []
  siteState.subscribe((_s, change) => {
    if (change && change.field === 'chatStage') stageWrites.push([change.to, change.origin])
  })

  api.openPanel()
  await settle()
  siteState.setSection('portfolio', { origin: 'visitor' })
  await settle()
  api.closePanelImmediate()
  await settle()

  assert.deepEqual(
    stageWrites,
    [['modal', 'visitor'], ['docked', 'system'], ['closed', 'visitor']],
    "opening and closing are the VISITOR; yielding to a site change is 'system' (§3.3 " +
    'reserves it for boot and layout-driven changes). Labelling the yield as the visitor ' +
    'would tell §7\'s live note the person had just moved the chat themselves, which they ' +
    'did not — and labelling it `agent` would be worse, since the dedupe would then swallow ' +
    'a note the agent does need'
  )
})

test('a yielded panel can be brought back — the stage has a way home', async (t) => {
  // THE TRAP THIS CLOSES. openPanel early-returns when isOpen() (js/chat.js), and isOpen()
  // is `!dialog.hidden` — which stageChrome says is FALSE for docked and minimized. So
  // without this, tapping a launcher while the chat sat minimised set the dock mode and
  // returned, and nothing on screen moved. On a narrow viewport the pill is all that is left
  // of the conversation, so that is a conversation with no way back: every entry point leads
  // to a panel the visitor cannot see, with their transcript still in it.
  const { api, siteState } = await boot('stage-restore', NARROW)
  t.after(() => api.disposeChatLiveVoice())

  siteState.setSection('portfolio', { origin: 'agent' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized', 'harness: must start yielded')

  // Every launcher in the site funnels through here (the EV_OPEN_CHAT handler, the footer
  // button, the spaceman, openPanelWithMessage).
  api.openPanel()
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'modal',
    'openPanel from a yielded stage must PROMOTE to modal. The visitor asked for the chat; ' +
    'an early return that only touches the dock mode leaves them tapping a launcher that ' +
    'does nothing'
  )

  // And again through the draft entry point, which is the same visitor act.
  siteState.setContactOpen(true, { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized')
  api.openPanelWithDraft('what else have you built?')
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'modal',
    'openPanelWithDraft / openPanelWithMessage must promote too'
  )
})

test('tapping the minimised pill restores it; tapping the docked card does not', async (t) => {
  // The pill IS the affordance. MEASURED in the browser: at the minimised size the panel
  // renders as the header alone — a title and a close X — so a visitor whose only visible
  // control is "close" can lose a live conversation to a mis-tap. The launcher is a way
  // back, but it is somewhere else on the page; the thing in front of them has to work.
  //
  // DOCKED IS DELIBERATELY NOT INCLUDED. A docked card is a usable panel with a composer, a
  // transcript and a voice pane in it. Promoting it on any click would mean the first tap
  // inside the transcript yanked the visitor back into a full-screen modal — the reducer's
  // `restore` is a visitor act, not a side effect of using what is already on screen.
  const { api, getEl, siteState } = await boot('stage-pill', NARROW)
  t.after(() => api.disposeChatLiveVoice())

  // `closest` answers by the simulated element's own classes, not by returning the target
  // for every selector. The blunt version (null for two known selectors, the target for the
  // rest) made `.chat-dialog__close` match a header click, so the guard that protects the
  // close button swallowed the restore — a stub that answered yes to everything, proving
  // nothing about which element was tapped.
  const clickDialog = (classes) => getEl('chatDialog').events.fire('click', {
    target: {
      className: classes,
      closest: (sel) => (
        sel.startsWith('.') && classes.split(/\s+/).includes(sel.slice(1))
          ? { className: classes }
          : null
      )
    }
  })

  siteState.setSection('portfolio', { origin: 'agent' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized', 'harness: must start as a pill')

  clickDialog('chat-dialog__header')
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'modal',
    'a tap on the pill must bring the conversation back'
  )

  // From docked, the same click must change nothing.
  window.innerWidth = WIDE
  window.matchMedia = () => ({ matches: true, addEventListener () {}, removeEventListener () {} })
  siteState.setSection('labs', { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'docked', 'harness: must now be docked')

  clickDialog('chat-dialog__scroll')
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'docked',
    'a click inside a docked card must NOT promote it — reading the transcript is not a ' +
    'request for a full-screen modal'
  )
})

test('Escape while yielded does not end the call — invariant #20, by keystroke', async (t) => {
  // THE DEFECT THIS PINS, found by the M2 critic pass and confirmed in shipped code.
  // js/chat.js's document-level Escape handler is guarded by `isOpen()`, which is
  // `!dialog.hidden` — and stageChrome deliberately keeps the dialog in the DOM for docked
  // AND minimized. So the handler fired while the chat was yielded and ran closePanel with
  // keepVoice defaulting to false, which reaches stopVoice.
  //
  // One keystroke, entirely plausible: live voice call, visitor taps a project card, chat
  // minimises correctly, visitor presses Escape to dismiss THE PROJECT DIALOG — and the
  // call dies. js/dialog-helpers.js's own Escape handler does not stopPropagation, so both
  // run. ADR-0015 §4.3 note 8 forbids exactly this ("Escape from minimized is a NO-OP …
  // would discard the transcript on a keystroke aimed at something else"), and the
  // reducer's table has always said so — as DATA, with no caller.
  const { api, siteState, docEvents } = await boot('stage-escape', NARROW)
  t.after(() => api.disposeChatLiveVoice())

  siteState.setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized', 'harness: must be yielded')
  assert.equal(api.liveVoice.isSessionOpen(), true, 'harness: the call must be up')

  const stops = []
  api.liveVoice.stopVoice = (o) => { stops.push(o || {}) }
  let defaultPrevented = false
  const fired = docEvents.fire('keydown', {
    key: 'Escape',
    preventDefault () { defaultPrevented = true }
  })
  assert.ok(fired > 0, 'harness: a keydown listener must be bound, or this is blind')
  await settle()

  assert.deepEqual(stops, [], 'Escape while yielded must not stop the voice session')
  assert.equal(api.liveVoice.isSessionOpen(), true, 'the call must survive the keystroke')
  assert.equal(
    siteState.getSiteState().chatStage, 'minimized',
    'and the stage must not move: a pill has nothing to dismiss (§4.3)'
  )
  assert.equal(
    defaultPrevented, false,
    'the chat must NOT swallow the keystroke while minimised — it was aimed at the project ' +
    'dialog in front of the visitor, and preventDefault here leaves that dialog stuck open'
  )
})

test('Escape from modal still closes, so the fix is not a blanket mute', async (t) => {
  const { api, siteState, docEvents } = await boot('stage-escape-modal', WIDE)
  t.after(() => api.disposeChatLiveVoice())

  assert.equal(siteState.getSiteState().chatStage, 'modal', 'harness: starts modal')
  docEvents.fire('keydown', { key: 'Escape', preventDefault () {} })
  await settle()
  assert.equal(
    siteState.getSiteState().chatStage, 'closed',
    "Escape from modal is today's shipped behaviour and §4.3 keeps it deliberately"
  )
})

test('every event in the reducer table has a caller, or it is not a feature', async (t) => {
  // The general form of the Escape defect. CHAT_STAGE_EVENTS has thirteen names and
  // test/chat-stage.test.mjs pins thirty-six transitions over them — but a table nobody
  // calls is exactly the defect this FILE says it exists to prevent, and seven of the
  // thirteen had no production caller at all. An event with no caller is either a missing
  // feature or a row that should be deleted; either way the table should not claim it.
  const { api } = await boot('stage-coverage', WIDE, { voice: false })
  t.after(() => api.disposeChatLiveVoice())

  const { CHAT_STAGE_EVENTS } = await import('../js/chat-stage.js')
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../js/chat.js', import.meta.url), 'utf8'
  ))

  // "Reachable" = the name appears as a quoted literal in js/chat.js. Deliberately looser
  // than matching `dispatchStage('<event>')`: the site events are dispatched through
  // `stageEventForChange`, which RETURNS the name rather than calling with it, and a check
  // that insisted on the call shape reported nine false positives on its first run. The
  // only reason to write one of these strings in that file is to dispatch it.
  //
  // TWO DELIBERATE EXEMPTIONS, named rather than quietly dropped:
  //   open-text / open-voice / close — opening and closing bypass the reducer on purpose
  //     (closing is more than chrome; opening is unconditional), so they are satisfied by
  //     the applyStage call that implements them.
  //   minimize — the reducer handles it and §4.3 specifies it, but M2 ships NO minimise
  //     affordance: the X closes, and the launcher restores. It is wired in M4 with the
  //     launcher work. Listed here so the gap is a decision on the record rather than an
  //     oversight that looks identical.
  const BYPASSED = { 'open-text': 'modal', 'open-voice': 'modal', close: 'closed' }
  //   open-beside — the reducer row and the geometry predicate land in ADR-0017's slices 7-9;
  //     its caller is the project chip in slice 13. Listed here for the same reason as
  //     minimize: an event with no caller is either a missing feature or a row that should
  //     be deleted, and the difference has to be a decision on the record rather than an
  //     oversight that looks identical to one.
  const NOT_YET_AFFORDED = ['minimize', 'open-beside']
  const uncalled = CHAT_STAGE_EVENTS.filter((event) => {
    if (NOT_YET_AFFORDED.includes(event)) return false
    if (new RegExp(`['"]${event}['"]`).test(src)) return false
    const stage = BYPASSED[event]
    return !(stage && new RegExp(`applyStage\\(\\s*['"]${stage}['"]`).test(src))
  })

  assert.deepEqual(
    uncalled, [],
    'these reducer events have no caller in js/chat.js, so the behaviour they describe ' +
    'does not exist: ' + JSON.stringify(uncalled) + '. Either wire them or take them out ' +
    'of CHAT_STAGE_EVENTS — a table that lists behaviour nobody can reach is how "Escape ' +
    'while docked minimizes" read as shipped while Escape actually ended the call'
  )
})

test('voiceActive is actually written, so the wire is not carrying a lie', async (t) => {
  // Found by the M2 critic pass: `setVoiceActive` was imported into js/chat.js and called
  // nowhere. ADR-0015 §3.2's writer row ("js/chat.js only, bridged from chat-live.js via
  // patchLiveUi") was never built, so the field sat false forever.
  //
  // Three silent consequences, which is why this is a defect and not a tidy-up:
  //   - getSiteStateForWire().voiceActive was always false, and §6.4 persists it on every
  //     turn as the admin panel's record of whether a failed turn happened during a call.
  //     A stored value that is wrong by construction is worse than an absent one.
  //   - siteStateWireIfNotable()'s `|| wire.voiceActive` clause was unreachable, so a
  //     visitor on home with a live call and nothing else open sent no siteState at all.
  //   - the live-note path only looked right because js/chat-live.js substitutes its own
  //     `voiceActive: true` when it renders — which is exactly what hid this.
  const { api, siteState } = await boot('stage-voiceactive', WIDE)
  t.after(() => api.disposeChatLiveVoice())

  assert.equal(api.liveVoice.isSessionOpen(), true, 'harness: the session must be up')
  assert.equal(
    siteState.getSiteState().voiceActive, true,
    'a live session must be visible in the store — this is the one field besides chatStage ' +
    'whose writer the ADR assigns to chat.js and nothing else'
  )
  assert.equal(siteState.getSiteStateForWire().voiceActive, true)

  api.liveVoice.stopVoice({ silent: true })
  await settle()
  assert.equal(
    siteState.getSiteState().voiceActive, false,
    'and it must go false when the call ends, or the next text turn is persisted as though ' +
    'the visitor were still talking'
  )
})

test('a viewport that narrows under a docked card minimises it', async (t) => {
  // §4.3's viewport rows, which had no caller either. A docked card is sized for a wide
  // viewport; left in place when the window narrows it covers the content it was supposed
  // to yield to. The reducer already says so — this is the listener that asks it.
  const { api, siteState, mediaListeners } = await boot('stage-viewport', WIDE)
  t.after(() => api.disposeChatLiveVoice())

  siteState.setSection('portfolio', { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'docked', 'harness: must start docked')

  // Exactly what a matchMedia change delivers.
  const widthSubs = mediaListeners.filter((m) => /min-width/.test(m.query))
  assert.ok(
    widthSubs.length > 0,
    'js/chat.js must subscribe to the width media query during init, or nothing can react ' +
    'to a resize. The harness records it, because a matchMedia installed AFTER the boot can ' +
    'never see a subscription the boot already made — which is how the first version of ' +
    'this row failed against a correct implementation'
  )
  for (const sub of widthSubs) sub.fn({ matches: false })
  await settle()

  assert.equal(
    siteState.getSiteState().chatStage, 'minimized',
    'narrowing under a docked card must yield further (§4.3). Left docked it covers the ' +
    'content it exists to make room for'
  )
})
