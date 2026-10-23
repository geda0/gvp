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
  // Critic: /api/live/transcript keeps the TEXT of what was said (userText/assistantText).
  assert.match(text, /voice[^.]*(written|text|transcri)/i, 'say that the words of a voice chat are kept as text')
  assert.doesNotMatch(text, /only how many bytes/i, 'byte counts are not ALL that a voice chat keeps')
  // Critic: chats stored before the ttl writer existed have no ttl and are not backfilled.
  assert.match(text, /older conversations[^.]*kept/i, 'say that conversations from before the rule are still kept')
  assert.match(text, /Google Gemini/i, 'the chat and voice content is processed by Google Gemini')
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

// Behaviour, not just copy: a minimal stub DOM drives initPrivacyNote end to end.
test('initPrivacyNote renders facts as text, opens, closes on Escape and backdrop, and restores focus', async () => {
  const listeners = { doc: {} }
  const mkEl = (id) => {
    const el = { id, hidden: true, attrs: {}, children: [], handlers: {}, focused: false,
      setAttribute (k, v) { this.attrs[k] = v },
      addEventListener (t, f) { this.handlers[t] = f },
      appendChild (c) { this.children.push(c) },
      focus () { doc.activeElement = this },
      querySelector (sel) { return sel === '.contact-dialog__close' ? closeBtn : sel === '.contact-dialog__backdrop' ? backdrop : null } }
    return el
  }
  const closeBtn = mkEl('close'); const backdrop = mkEl('backdrop')
  const openBtn = mkEl('footerOpenPrivacyBtn'); const dialog = mkEl('privacyDialog'); const list = mkEl('privacyFacts')
  const bodyClasses = new Set()
  const doc = {
    activeElement: null,
    body: { classList: { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c) } },
    getElementById: (id) => ({ footerOpenPrivacyBtn: openBtn, privacyDialog: dialog, privacyFacts: list })[id] || null,
    createElement: () => ({ textContent: '', innerHTML: '' }),
    addEventListener: (t, f) => { listeners.doc[t] = f }
  }
  globalThis.document = doc
  try {
    const { initPrivacyNote } = await import('../js/privacy-note.js?behaviour')
    initPrivacyNote()
    assert.equal(list.children.length, privacyFacts().length)
    assert.ok(list.children.every((li) => li.textContent && !li.innerHTML), 'facts go in as textContent, never HTML')

    openBtn.focus(); openBtn.handlers.click()
    assert.equal(dialog.hidden, false); assert.ok(bodyClasses.has('privacy-dialog-open'))
    assert.equal(doc.activeElement, closeBtn, 'focus moves into the dialog')

    listeners.doc.keydown({ key: 'Escape', preventDefault () {} })
    assert.equal(dialog.hidden, true); assert.ok(!bodyClasses.has('privacy-dialog-open'))
    assert.equal(doc.activeElement, openBtn, 'focus returns to the footer button')

    openBtn.handlers.click(); backdrop.handlers.click()
    assert.equal(dialog.hidden, true, 'backdrop click closes')
  } finally {
    delete globalThis.document
  }
})
