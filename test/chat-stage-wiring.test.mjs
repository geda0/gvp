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
    pointerEventsOnShell: dialog.style.pointerEvents || 'none'
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
