import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveReplyText } from '../js/chat-reply-text.js'

const BROKEN = 'I do not have a response yet. Please try again.'

test('real prose passes through untouched (trimmed)', () => {
  assert.equal(deriveReplyText('  Hello there.  ', []), 'Hello there.')
})

test('empty reply + open-resume action → useful résumé line, not the broken fallback', () => {
  const out = deriveReplyText('', [{ id: 'open-resume', label: 'Open resume' }])
  assert.notEqual(out, BROKEN)
  assert.match(out, /résumé to download/)
  assert.match(out, /Portfolio/)
})

test('empty reply + navigate(portfolio) → invites to the Portfolio', () => {
  const out = deriveReplyText('', [{ id: 'navigate', section: 'portfolio' }])
  assert.notEqual(out, BROKEN)
  assert.match(out, /the Portfolio/)
})

test('empty reply + navigate(labs) → invites to Labs', () => {
  const out = deriveReplyText('', [{ id: 'navigate', section: 'labs' }])
  assert.match(out, /Labs/)
})

test('empty reply + navigate(home) → invites to Home', () => {
  const out = deriveReplyText('', [{ id: 'navigate', section: 'home' }])
  assert.match(out, /Home/)
})

test('navigate wins over open-resume when both are present', () => {
  const out = deriveReplyText('', [
    { id: 'open-resume' },
    { id: 'navigate', section: 'portfolio' },
  ])
  assert.match(out, /the Portfolio/)
})

test('empty reply + open-contact action → contact-form line', () => {
  const out = deriveReplyText('', [{ id: 'open-contact' }])
  assert.notEqual(out, BROKEN)
  assert.match(out, /contact form/)
})

test('empty reply with no actions still falls back to the try-again line', () => {
  assert.equal(deriveReplyText('', []), BROKEN)
  assert.equal(deriveReplyText(null), BROKEN)
  assert.equal(deriveReplyText(undefined, undefined), BROKEN)
})

test('whitespace-only reply is treated as empty', () => {
  const out = deriveReplyText('   \n  ', [{ id: 'open-resume' }])
  assert.match(out, /résumé to download/)
})
