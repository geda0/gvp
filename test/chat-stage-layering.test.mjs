import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')

// Where does a YIELDED assistant sit in the stack?
//
// MEASURED IN A BROWSER, 2026-10-17, which is the only reason this file exists — every unit
// test in the milestone was green while this was wrong. With the chat minimised and the
// contact dialog open:
//
//     #chatDialog    z-index 1095
//     .contact-dialog z-index 1090
//
// so the pill floats ABOVE the form the visitor is filling in. At 1024x768 the two happen
// not to overlap (the pill is bottom-right, the form is centred), which is exactly why
// nothing caught it: the defect is a function of viewport, and on a taller or narrower one
// the form reaches the corner and the pill lands on top of it.
//
// THE RULE, and it is the general form rather than the three numbers: a MODAL stage may sit
// above the site's dialogs — that is what modal means — but a YIELDED stage must sit below
// anything the visitor is currently interacting with. "Yielded" that still covers the thing
// you are typing into is not yielded. This is invariant #22's territory ("the site remains
// operable"), and the backdrop clause is the same argument one layer down.
//
// WHY A SOURCE ASSERTION AND NOT A BROWSER ONE: this repo has no browser E2E and no test
// dependencies (ADR-0015 §11.6 keeps the journey harness last for that reason). The numbers
// are static declarations, so reading them is not a proxy for the behaviour — it IS the
// behaviour, as long as the test reads the same files the browser does. The browser check
// that found it is recorded above so nobody has to rediscover it.

const Z = /z-index:\s*(\d+)/

function zIndexOf (css, selector) {
  // The declaration block for exactly this selector, taking the LAST one so a later
  // override is what we read — the same thing the cascade does.
  const blocks = [...css.matchAll(new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'gm'
  ))]
  assert.ok(blocks.length, `no rule found for ${selector}`)
  for (const b of blocks.reverse()) {
    const m = Z.exec(b[2])
    if (m) return Number(m[1])
  }
  assert.fail(`${selector} declares no z-index`)
}

test('a yielded assistant sits BELOW the dialogs the visitor is using', () => {
  const chatCss = read('css', 'chat.css')
  const siteCss = read('css', 'styles.css')

  const contact = zIndexOf(siteCss, '.contact-dialog')
  const project = zIndexOf(siteCss, '.project-dialog')
  const yielded = zIndexOf(chatCss, "#chatDialog[data-chat-stage='docked'],\n#chatDialog[data-chat-stage='minimized']")

  assert.ok(
    yielded < contact,
    `a yielded chat (z-index ${yielded}) must sit below the contact dialog (${contact}). ` +
    'MEASURED: at 1095 vs 1090 the minimised pill floats over the form the visitor is ' +
    'filling in — invisible at 1024x768, where the two happen not to overlap, and a direct ' +
    'hit on a taller viewport where the form reaches the corner'
  )
  assert.ok(
    yielded < project,
    `a yielded chat (z-index ${yielded}) must sit below the project dialog (${project})`
  )
})

test('a MODAL assistant sits above EVERY site dialog, not just the contact one', () => {
  // MEASURED IN A REAL BROWSER, 2026-10-23, at 1280x900 and 1512x950 — and this is a LIVE
  // defect on prod and stage today, not a hypothetical:
  //   - with a project dialog open, elementFromPoint over #agentNode returns the PROJECT
  //     DIALOG, so nothing in the site can open the chat at all; and
  //   - force the chat open anyway and its panel is ALSO behind the dialog, so a visitor
  //     who reaches it can neither read nor click it.
  // Cause: .project-dialog is inset:0 at z-index 1100 and .chat-dialog was 1095.
  //
  // The contact dialog (1090) happened to already sit below the chat, which is why the
  // previous version of this row passed while the project dialog — the one M4's project
  // chips are about to make reachable — did not. Asserting against EVERY dialog rather than
  // one named dialog is the difference between catching the class and catching the instance
  // somebody happened to think of.
  const chatCss = read('css', 'chat.css')
  const siteCss = read('css', 'styles.css')
  const modal = zIndexOf(chatCss, '.chat-dialog')

  for (const dialog of ['.contact-dialog', '.project-dialog']) {
    assert.ok(
      modal > zIndexOf(siteCss, dialog),
      `a modal chat (z-index ${modal}) must sit above ${dialog} ` +
      `(${zIndexOf(siteCss, dialog)}). An OPEN chat is modal and belongs on top; the rule ` +
      'above is about the YIELDED stages only, and the two must not be confused — dropping ' +
      'the modal stage would put the chat behind a backdrop it raised itself, while raising ' +
      'the yielded ones would make a pill cover the page it exists to step aside from'
    )
  }
})

test('the yielded stages did NOT move when modal did', () => {
  // The paired half. Raising modal above the project dialog is correct; raising the pill
  // with it is the regression this file already records a browser measurement for — and the
  // plan explicitly asked for it ("pill 1106"). Both assertions live in one file so a future
  // edit cannot satisfy one by breaking the other without seeing both.
  const chatCss = read('css', 'chat.css')
  const siteCss = read('css', 'styles.css')
  const yielded = zIndexOf(chatCss, "#chatDialog[data-chat-stage='docked'],\n#chatDialog[data-chat-stage='minimized']")
  for (const dialog of ['.contact-dialog', '.project-dialog']) {
    assert.ok(
      yielded < zIndexOf(siteCss, dialog),
      `a yielded chat (${yielded}) must stay below ${dialog}. "Yielded" that covers the ` +
      'thing the visitor turned to is not yielded'
    )
  }
})

test('the yielded panel takes its own pointer events back', () => {
  // The other half of the shell's `pointer-events: none`, and it had no assertion at all.
  // The SHELL is switched off so the site underneath is clickable; the PANEL has to switch
  // itself back on, or the docked card and the pill are dead to clicks — no close X, no
  // restore tap, no composer — while the suite stays green, because every click row in the
  // suite fires events directly on a stub element and never hit-tests.
  //
  // Caught by the M2 critic pass. One deleted CSS declaration, invisible in review, and the
  // symptom is an assistant you can see and cannot use.
  const css = read('css', 'chat.css')
  const block = /#chatDialog\[data-chat-stage='docked'\] \.chat-dialog__panel,\s*\n#chatDialog\[data-chat-stage='minimized'\] \.chat-dialog__panel \{([^}]*)\}/
    .exec(css)
  assert.ok(block, 'the yielded-panel rule is gone or was renamed — update this test with it')
  assert.match(
    block[1], /pointer-events:\s*auto/,
    'the yielded panel must re-enable pointer events. The shell above it is set to `none` ' +
    'so the site stays usable, and nothing else turns them back on for the card itself'
  )
})

test('ADR-0027 §4: the docked width has ONE source of truth, --chat-dock-width from dockedCardWidth', () => {
  // CSS must not restate 720 / 320: hasRoomBesideDialog needs the same number in JS, and two
  // copies of one formula is the drift ADR-0017 §2.4 warned about. The var() fallback is the
  // shipped compact rule, so JS failing to run degrades to today's card.
  const css = read('css', 'chat.css')
  const block = /#chatDialog\[data-chat-stage='docked'\] \.chat-dialog__panel \{([^}]*)\}/.exec(css)
  assert.ok(block, 'the docked panel rule is gone or was renamed')
  assert.match(block[1], /(^|\s)width:\s*var\(--chat-dock-width,\s*min\(24rem, calc\(100vw - 2rem\)\)\)/)
  assert.match(block[1], /max-width:\s*var\(--chat-dock-width,\s*min\(24rem, calc\(100vw - 2rem\)\)\)/)
  const stageBlock = css.slice(css.indexOf('the stage (ADR-0015 §4)'))
  assert.doesNotMatch(stageBlock, /(?<![\d.])(720px|45rem|320px)/,
    'the wide cap and the uncovered floor live in js/chat-stage.js only')
})

test('a card docked BESIDE a project dialog sits above its scrim, below the modal chat and the tour', () => {
  // MEASURED (scripts/qa/chat-stage-journeys.mjs, "W6 beside a project dialog"): at
  // 1920x1080 elementFromPoint over the beside card returned the PROJECT DIALOG, because the
  // card was at the yielded 1085 under .project-dialog's inset:0 1100 scrim. ADR-0027 §9 filed
  // it; this is the fix. ONLY the beside case moves (js/chat.js marks it data-chat-beside
  // only when the card was measured to fit without overlapping the panel); the yielded rule
  // above is untouched, so a card the visitor stepped away from still sits under the dialog.
  const chatCss = read('css', 'chat.css')
  const siteCss = read('css', 'styles.css')
  const beside = zIndexOf(chatCss, "#chatDialog[data-chat-stage='docked'][data-chat-beside='true']")
  const project = zIndexOf(siteCss, '.project-dialog')
  const modal = zIndexOf(chatCss, '.chat-dialog')
  const tour = zIndexOf(chatCss, '.tour-card')
  assert.ok(beside > project, `beside card (${beside}) must sit above the project dialog scrim (${project})`)
  assert.ok(beside < modal, `and below a modal chat (${modal})`)
  assert.ok(beside < tour, `and below the tour card (${tour}), which must stay on top at every stage`)
})
