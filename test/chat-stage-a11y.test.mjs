import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { settle, bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'
import { stageChrome } from '../js/chat-stage.js'

// Invariant #22's clauses that nothing was asserting.
//
// The critic pass found four of them live only in the ADR's prose and in `stageChrome`'s
// data table: no focus move on entry to a yielded stage, no focus trap, the transcript
// keeps its `aria-live`, and stage transitions honour `prefers-reduced-motion`. #22 is the
// milestone's whole user-visible claim and it was promoted against this file's own bar on
// the argument that the regression is ONE line and invisible in review — so leaving most of
// its clauses to a browser harness that does not exist yet is the gap worth closing first.
//
// None of these needs a browser. Focus is a spy, `aria-live` is an attribute, and the
// reduced-motion rule is a CSS declaration — the same technique the layering and
// collapse-grep rows already use, for the same reason.

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')

const WIDE = 1280

async function boot (tag) {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const h = await bootChatWithLiveVoice({ tag })
  window.innerWidth = WIDE
  window.matchMedia = (q) => ({
    matches: /min-width/.test(q), addEventListener () {}, removeEventListener () {}
  })
  return { ...h, siteState }
}

test('yielding never moves focus — the visitor is using the SITE', async (t) => {
  // stageChrome says moveFocus: 'none' for docked and minimized, and until now that lived
  // only in the data table: `expectedChrome` strips the field before comparing, so adding a
  // composerInput.focus() to the yielded branch broke nothing.
  //
  // Why it matters more than it looks: a focus jump on a layout change is disorienting for
  // everyone and disabling for someone navigating by keyboard or screen reader — they are
  // moved out of the thing they were reading, by a panel that is supposed to be getting out
  // of their way.
  const { api, getEl, siteState } = await boot('a11y-focus')
  t.after(() => api.disposeChatLiveVoice())

  assert.equal(stageChrome('docked').moveFocus, 'none', 'the contract itself must say none')

  // Spy on every element the chat could plausibly focus.
  const focused = []
  for (const id of ['chatComposerInput', 'chatVoiceStartBtn', 'chatVoiceMic', 'agentInput']) {
    const el = getEl(id)
    el.focus = () => focused.push(id)
  }
  const panel = getEl('chatDialog').querySelector('.chat-dialog__panel')
  panel.focus = () => focused.push('panel')

  siteState.setSection('portfolio', { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'docked', 'harness: must have yielded')
  assert.deepEqual(focused, [], `yielding moved focus to ${JSON.stringify(focused)}`)

  siteState.setContactOpen(true, { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized')
  assert.deepEqual(focused, [], 'minimising must not move focus either')
})

test('the transcript keeps its live region in every visible stage', async (t) => {
  // A yielded assistant that is still talking has to stay announceable. Setting
  // aria-live="off" when docked would silence the agent for exactly the users who cannot
  // see the card — invisible in a diff, and the suite never read this element at all.
  const { api, getEl, siteState } = await boot('a11y-live')
  t.after(() => api.disposeChatLiveVoice())

  const messages = getEl('chatMessages')
  const liveIn = (stage) => ({
    stage,
    ariaLive: messages.getAttribute('aria-live'),
    role: messages.getAttribute('role')
  })

  const seen = [liveIn('modal')]
  siteState.setSection('portfolio', { origin: 'visitor' })
  await settle()
  seen.push(liveIn('docked'))
  siteState.setContactOpen(true, { origin: 'visitor' })
  await settle()
  seen.push(liveIn('minimized'))

  for (const row of seen) {
    assert.notEqual(
      row.ariaLive, 'off',
      `the transcript must not be silenced in the ${row.stage} stage — a yielded assistant ` +
      'that is still speaking has to stay announceable'
    )
  }
})

test('the markup declares the live region, and the chat never takes it away', () => {
  // The DOM rows above run against a stub whose attributes start unset, so they can only
  // prove the chat does not SET aria-live="off". That the region exists at all is a fact
  // about index.html, and that nothing strips it is a fact about js/chat.js.
  assert.match(
    read('index.html'), /id="chatMessages"[^>]*aria-live="polite"/,
    'the transcript must declare aria-live="polite" (role="log") in the markup'
  )
  const code = read('js', 'chat.js')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.doesNotMatch(
    code, /removeAttribute\(\s*['"]aria-live['"]|aria-live['"]\s*,\s*['"]off/,
    'nothing in the chat may silence the transcript'
  )
})

test('the chat does not trap focus, in any stage', () => {
  // §4.4 is explicit that the dialog has no focus trap today and that nobody should "fix"
  // one into it while the yielded stages exist: a trap in a docked card would hold the
  // keyboard inside a panel that has deliberately stepped aside, which is strictly worse
  // than having no trap at all.
  const code = read('js', 'chat.js')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.doesNotMatch(
    code, /key\s*===\s*['"]Tab['"]|['"]Tab['"]\s*===|trapFocus/,
    'a Tab handler appeared in js/chat.js. If a focus trap is wanted it must be scoped to ' +
    'the modal stage and this row updated deliberately — a trap that survives into docked ' +
    'or minimized holds the keyboard inside a panel that has stepped aside'
  )
})

test('stage transitions honour prefers-reduced-motion', () => {
  const css = read('css', 'chat.css')
  const block = /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*#chatDialog\[data-chat-stage\][^}]*\{([^}]*)\}/
    .exec(css)
  assert.ok(
    block,
    'no reduced-motion rule covers the stage transitions. The panel carries a 280ms ' +
    'transform transition, and a stage change moves and resizes it — that is exactly the ' +
    'motion #6 and #22 say must be suppressible'
  )
  assert.match(block[1], /transition:\s*none/)
})

test('ADR-0027 §4.1: the size toggle is a pressed-state button with a fixed name that keeps focus', async (t) => {
  // aria-pressed, NOT aria-expanded: it changes the size of the region it lives in, it does
  // not show other content. The NAME never swaps - a pressed button whose label also flips
  // reads as a double negative. And it is HIDDEN wherever wide cannot render or the card is
  // not docked, because a control that does nothing is noise to a screen reader.
  const { api, getEl, siteState } = await boot('a11y-size-toggle')
  t.after(() => api.disposeChatLiveVoice())
  const toggle = getEl('chatDialog').querySelector('[data-chat-size-toggle]')
  toggle.setAttribute('aria-label', 'Wide chat window') // as the markup ships it
  const focused = []
  toggle.focus = () => focused.push('toggle')
  getEl('chatComposerInput').focus = () => focused.push('composer')

  const read = () => ({
    hidden: Boolean(toggle.hidden),
    pressed: toggle.getAttribute('aria-pressed'),
    label: toggle.getAttribute('aria-label')
  })
  const seen = { modal: read() }
  siteState.setSection('portfolio', { origin: 'visitor' })
  await settle()
  seen.docked = read()
  toggle.events.fire('click', { stopPropagation () {}, target: toggle })
  await settle()
  seen.toggled = read()
  siteState.setContactOpen(true, { origin: 'visitor' })
  await settle()
  seen.minimized = read()

  assert.deepEqual(seen, {
    modal: { hidden: true, pressed: 'true', label: 'Wide chat window' },
    docked: { hidden: false, pressed: 'true', label: 'Wide chat window' },
    toggled: { hidden: false, pressed: 'false', label: 'Wide chat window' },
    minimized: { hidden: true, pressed: 'false', label: 'Wide chat window' }
  })
  assert.deepEqual(focused, [], 'a toggle press must not move focus anywhere - it stays on the toggle')
  assert.equal(getEl('chatDialog').querySelector('.chat-dialog__panel').getAttribute('aria-modal'), 'false',
    'docked at both sizes is non-modal')
})

test('ADR-0027 §5.2: minimising the focused main window hands focus to the resume chip', async (t) => {
  // Docked is now the default window, so the composer usually HOLDS focus when the visitor
  // presses minimise or Escape. Hiding it would drop focus to <body>; the "Assistant active"
  // chip (whose click is restore) is where it goes instead. A SYSTEM minimise (the contact
  // dialog opening) must not move it - that dialog is taking focus itself.
  const { api, getEl, siteState, docEvents } = await boot('a11y-resume-chip')
  t.after(() => api.disposeChatLiveVoice())
  const dialog = getEl('chatDialog')
  const panel = dialog.querySelector('.chat-dialog__panel')
  const composer = getEl('chatComposerInput')
  const chip = getEl('agentActiveChip')
  panel.contains = (el) => el === composer
  const focused = []
  chip.focus = () => focused.push(chip.hidden ? 'hidden-chip' : 'chip')

  const toDocked = async () => {
    api.openPanel()
    await settle()
    assert.equal(siteState.getSiteState().chatStage, 'docked', 'harness: docked')
    document.activeElement = composer
  }

  await toDocked()
  dialog.querySelector('.chat-dialog__minimize').events.fire('click', { stopPropagation () {} })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized')
  assert.deepEqual(focused, ['chip'], 'the minimise button must hand focus to the VISIBLE resume chip')

  await toDocked()
  docEvents.fire('keydown', { key: 'Escape', preventDefault () {} })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized', 'Escape on docked minimises (N-W3)')
  assert.deepEqual(focused, ['chip', 'chip'], 'and so does Escape')

  await toDocked()
  siteState.setContactOpen(true, { origin: 'visitor' })
  await settle()
  assert.equal(siteState.getSiteState().chatStage, 'minimized')
  assert.deepEqual(focused, ['chip', 'chip'], 'a system minimise never moves focus')

  // Focus outside the card: a requested minimise leaves it where the visitor put it.
  siteState.setContactOpen(false, { origin: 'visitor' })
  await settle()
  document.activeElement = getEl('somewhereOnThePage')
  dialog.querySelector('.chat-dialog__minimize').events.fire('click', { stopPropagation () {} })
  await settle()
  assert.deepEqual(focused, ['chip', 'chip'], 'focus outside the card is not ours to move')
})

test('ADR-0027 §4 / W7: the size transition exists only under prefers-reduced-motion: no-preference', () => {
  // Declared ONLY inside no-preference, so the reduce rule above (transition: none) can never
  // be out-specified by it - #22's "transitions honour reduced motion" covers size by
  // construction rather than by a specificity race.
  const css = read('css', 'chat.css')
  const np = /@media \(prefers-reduced-motion: no-preference\) \{\s*#chatDialog\[data-chat-stage='docked'\] \.chat-dialog__panel \{([^}]*)\}/
    .exec(css)
  assert.ok(np, 'no size transition for the docked card under no-preference')
  assert.match(np[1], /transition:[^;]*width 200ms[^;]*max-width 200ms/)
  // And nowhere else: a docked-panel transition declared outside the media query would apply
  // under reduce too.
  const outside = css.replace(np[0], '')
  assert.doesNotMatch(
    outside, /#chatDialog\[data-chat-stage='docked'\][^{]*\.chat-dialog__panel \{[^}]*transition:/,
    'a docked-panel transition outside no-preference applies under reduced motion too'
  )
})

test('ADR-0027 §4.1: the size toggle renders only on the docked card, and [hidden] wins', () => {
  const css = read('css', 'chat.css')
  assert.match(css, /\.chat-dialog__size\s*\{[^}]*display:\s*none/, 'hidden by default')
  assert.match(
    css, /\[data-chat-stage=["']docked["']\][^{]*\.chat-dialog__size\s*\{[^}]*display:\s*inline-flex/,
    'shown on the docked card, exactly like minimise'
  )
  // toggleHidden (below 840px, beside a dialog with no room for wide) must beat the docked
  // rule's display - a bare [hidden] loses to any author `display`.
  assert.match(
    css, /\[data-chat-stage=["']docked["']\][^{]*\.chat-dialog__size\[hidden\]\s*\{[^}]*display:\s*none/,
    'the [hidden] rule must be at least as specific as the docked display rule'
  )
  assert.match(css, /\.chat-dialog__size:focus-visible\s*\{[^}]*outline/, 'a visible focus ring (W2)')
})
