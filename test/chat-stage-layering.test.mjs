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

test('a MODAL assistant still sits above them — yielding is the exception, not the rule', () => {
  const chatCss = read('css', 'chat.css')
  const siteCss = read('css', 'styles.css')
  const modal = zIndexOf(chatCss, '.chat-dialog')
  assert.ok(
    modal > zIndexOf(siteCss, '.contact-dialog'),
    'an OPEN chat dialog is modal and belongs on top; the rule above is about the yielded ' +
    'stages only. Dropping the modal stage too would put the chat behind a backdrop it ' +
    'raised itself'
  )
})
