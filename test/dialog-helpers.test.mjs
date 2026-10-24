import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { makeListeners, defineGlobal } from './fixtures/chat-harness.mjs'
import { bindEscapeClosesDialogWhenOpen } from '../js/dialog-helpers.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

// ADR-0029 §6.2: Escape routed by focus. Beside a reserved project dialog the chat is a second
// interactive dialog, and both bound Escape at the document - one keystroke in the composer
// closed the project too. The shared helper takes an optional selector to stay out of.

function stubDocument (activeInside) {
  const events = makeListeners()
  defineGlobal('document', {
    activeElement: { closest: (sel) => (activeInside && sel === '#chatDialog' ? {} : null) },
    addEventListener: (type, fn) => events.add(type, fn)
  })
  return events
}

const escape = (events) => {
  let prevented = false
  events.fire('keydown', { key: 'Escape', preventDefault () { prevented = true } })
  return prevented
}

test('ADR-0029 §6.2: Escape does not close a dialog while focus is inside the ignored selector', () => {
  const closes = []
  const events = stubDocument(true)
  bindEscapeClosesDialogWhenOpen({ hidden: false }, () => closes.push('closed'), { ignoreFocusWithin: '#chatDialog' })
  const prevented = escape(events)
  assert.deepEqual([closes, prevented], [[], false], 'focus in the chat: the project dialog stays open and the key is not swallowed')

  const outside = stubDocument(false)
  bindEscapeClosesDialogWhenOpen({ hidden: false }, () => closes.push('closed'), { ignoreFocusWithin: '#chatDialog' })
  escape(outside)
  assert.deepEqual(closes, ['closed'], 'focus anywhere else: Escape closes it, as before')
})

test('ADR-0029 §6.2: the project dialog ignores Escape from the chat; contact and privacy are unchanged', () => {
  assert.match(read('js/projects.js'),
    /bindEscapeClosesDialogWhenOpen\(dialog, closeDialog, \{ ignoreFocusWithin: '#chatDialog' \}\)/)
  assert.match(read('js/contact.js'), /bindEscapeClosesDialogWhenOpen\(dialog, closeDialog\)$/m, 'contact passes nothing')
  assert.match(read('js/privacy-note.js'), /bindEscapeClosesDialogWhenOpen\(dialog, close\)$/m, 'privacy passes nothing')
})
