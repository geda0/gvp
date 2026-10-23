// M4 slice 16 (ADR-0017 §7) — selection offers. A privacy claim ("the quote reaches the model
// only on an explicit tap") enforced at four seams rather than by convention:
//   7.1 the decision is a pure leaf that cannot send
//   7.2 the ONLY sink is openPanelWithDraft (fills the composer, does not submit) — pinned by a
//       source assertion, because draft -> message is a one-word edit a diff reads as a synonym
//   7.3 analytics carry a bucketed length and the section, never the text
//   7.4 an allowlist of content regions (Firefox reports textarea selections; the contact form's
//       message is the visitor's own words to the owner)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { selectionOffer, charBucket, OFFER_REGIONS } from '../js/selection-offer.js'
import { initSelectionOffers } from '../js/selection-offer-ui.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const LONG = 'Migrated a multi-tenant SaaS onto Kubernetes without downtime. '.repeat(20)

test('7.1: shows only inside an allowlisted content region', () => {
  for (const region of OFFER_REGIONS) {
    assert.deepEqual(selectionOffer({ text: 'Migrated onto Kubernetes without downtime', withinRegion: region }),
      { show: true, quote: 'Migrated onto Kubernetes without downtime', reason: 'ok' })
  }
  for (const region of [null, '', 'contact-message', 'chat-composer', 'constructor']) {
    assert.equal(selectionOffer({ text: 'Migrated onto Kubernetes', withinRegion: region }).reason, 'region-not-allowed')
  }
})

test('7.1: too short is refused; too long is CLAMPED (a quote is a value, not an identity)', () => {
  assert.equal(selectionOffer({ text: ' hi ', withinRegion: OFFER_REGIONS[0] }).reason, 'too-short')
  const long = selectionOffer({ text: LONG, withinRegion: OFFER_REGIONS[0] })
  assert.equal(long.show, true)
  assert.equal(long.reason, 'too-long')
  assert.ok(long.quote.length <= 300 && long.quote.endsWith('…'))
})

test('7.1: the leaf has no way to send — no fetch, no analytics, no DOM', () => {
  const src = read('js/selection-offer.js')
  assert.doesNotMatch(src, /\bfetch\(|trackEvent|recordEvent|document\.|window\.|import /)
})

test('7.2: no module that imports the selection leaf may reference openPanelWithMessage', () => {
  const importers = readdirSync(new URL('../js/', import.meta.url))
    // Scoped as ADR-0017 §7.2 scopes it: importers of the selection LEAF. app.js imports only the
    // UI glue (with openDraft injected) and legitimately wires the hero's submitting launcher.
    .filter((f) => f.endsWith('.js') && /selection-offer\.js'/.test(read(`js/${f}`)))
  assert.ok(importers.includes('selection-offer-ui.js'), `importers: ${importers}`)
  for (const f of importers) assert.doesNotMatch(read(`js/${f}`), /openPanelWithMessage/, `${f} can submit`)
})

test('7.3: charBucket is coarse and the UI tracks only { chars, section }', () => {
  assert.equal(charBucket(5), '1-49')
  assert.equal(charBucket(120), '50-199')
  assert.equal(charBucket(260), '200+')
  const ui = read('js/selection-offer-ui.js')
  for (const m of ui.matchAll(/track\(\s*'[^']+',\s*\{([^}]*)\}/g)) {
    const keys = m[1].split(',').map((p) => p.split(':')[0].trim()).filter(Boolean).sort()
    assert.deepEqual(keys, ['chars', 'section'], `analytics params must be exactly { chars, section }: ${m[0]}`)
  }
})

// A behavioural run of the glue over an injected selection, so the sink is proven, not just named.
function harness ({ text, region }) {
  const drafts = []; const events = []; const listeners = {}
  const button = { hidden: true, style: {}, textContent: '', handlers: {}, addEventListener (t, f) { this.handlers[t] = f }, setAttribute () {} }
  const doc = {
    createElement: () => button,
    body: { appendChild () {} },
    addEventListener: (t, f) => { listeners[t] = f }
  }
  const anchor = { closest: (sel) => (region && sel === region.selector ? {} : null) }
  const selection = { toString: () => text, rangeCount: 1, anchorNode: { parentElement: anchor }, getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20, bottom: 30, width: 40 }) }) }
  initSelectionOffers({ doc, getSelection: () => selection, openDraft: (t) => drafts.push(t), track: (n, p) => events.push([n, p]), getSection: () => 'portfolio' })
  return { button, drafts, events, listeners }
}

test('7.2 behaviour: a tap fills the composer with the quote, and nothing is sent', () => {
  const h = harness({ text: 'Migrated onto Kubernetes without downtime', region: { selector: '#portfolioContent' } })
  h.listeners.mouseup()
  assert.equal(h.button.hidden, false, 'an offer appears for an allowlisted selection')
  h.button.handlers.click({ preventDefault () {} })
  assert.equal(h.drafts.length, 1)
  assert.match(h.drafts[0], /Migrated onto Kubernetes without downtime/)
  for (const [, params] of h.events) assert.deepEqual(Object.keys(params).sort(), ['chars', 'section'])
  assert.ok(!JSON.stringify(h.events).includes('Kubernetes'), 'the quote never reaches analytics')
})

test('7.4 behaviour: a selection in the contact form never produces an offer', () => {
  const h = harness({ text: 'Hi Marwan, my private budget is 40k', region: null })
  h.listeners.mouseup()
  assert.equal(h.button.hidden, true)
  assert.equal(h.events.length, 0)
})

test('app.js wires the offers to openPanelWithDraft', () => {
  assert.match(read('js/app.js'), /initSelectionOffers\(\{[\s\S]{0,300}openDraft:[\s\S]{0,120}openPanelWithDraft/)
})


test('critic: the mouseup that ends a tap on the offer button does not count a second offer', () => {
  const h = harness({ text: 'Migrated onto Kubernetes without downtime', region: { selector: '#portfolioContent' } })
  h.listeners.mouseup({ target: {} })
  h.listeners.mouseup({ target: h.button }) // the button's own mouseup bubbles to the document
  h.button.handlers.click({ preventDefault () {} })
  assert.deepEqual(h.events.map(([n]) => n), ['selection_assistant_offer', 'selection_assistant_chip'])
})

test('the draft is a complete sentence the visitor can send as is (openPanelWithDraft trims)', () => {
  const h = harness({ text: 'Migrated onto Kubernetes without downtime', region: { selector: '#portfolioContent' } })
  h.listeners.mouseup({ target: {} })
  h.button.handlers.click({ preventDefault () {} })
  assert.equal(h.drafts[0], 'Tell me more about this: "Migrated onto Kubernetes without downtime"')
})
