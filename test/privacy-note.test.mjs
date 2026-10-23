// M8 item 5 (ADR-0021 D4). The privacy note may only claim what the code does, so its
// numbers are DERIVED from the constants that enforce them, and the one uncomfortable fact
// (Google Analytics sees the visitor's IP) is required to be in it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { privacyFacts, TRANSCRIPT_RETENTION_DAYS, EVENT_RETENTION_DAYS } from '../js/privacy-note.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('retention numbers in the note are the ones the code enforces', () => {
  const store = read('docker/chat/app/transcript_store.py')
  assert.equal(TRANSCRIPT_RETENTION_DAYS, Number(store.match(/^_DEFAULT_TTL_DAYS = (\d+)/m)[1]))
  const events = read('aws/src/common/events-shared.js')
  assert.equal(EVENT_RETENTION_DAYS, Number(events.match(/EVENT_TTL_DAYS = (\d+)/)[1]))
})

test('the note states each verified fact, including that Google Analytics sees the IP', () => {
  const text = privacyFacts().join('\n')
  assert.match(text, new RegExp(`${TRANSCRIPT_RETENTION_DAYS} days`))
  assert.match(text, new RegExp(`${EVENT_RETENTION_DAYS} days`))
  assert.match(text, /no audio/i)
  assert.match(text, /microphone/i)
  assert.match(text, /Google Analytics[^.]*IP/i)
  assert.doesNotMatch(text, /consent|we never|anonymous/i, 'no claim the code cannot back')
})

test('the SITE footer opens it, and app.js initialises it', () => {
  const html = read('index.html')
  const footer = html.split('<footer>')[1].split('</footer>')[0]
  assert.match(footer, /id="footerOpenPrivacyBtn"/)
  assert.match(html, /id="privacyDialog"[^>]*hidden/)
  assert.match(html, /id="privacyFacts"/)
  assert.match(read('js/app.js'), /initPrivacyNote\(\)/)
})
