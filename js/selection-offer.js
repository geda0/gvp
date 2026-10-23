// M4 slice 16 (ADR-0017 §7.1) — should a text selection get an "ask about this" offer?
// PURE and deliberately powerless: it decides and clamps. No network, no analytics, no DOM -
// it is given nothing because it needs nothing, so it cannot be the place a quote leaks.
//
// Regions are an ALLOWLIST of site content (§7.4). Firefox reports the selected text of a
// <textarea>, and the contact form's message is the visitor's own words to the owner - so
// "the browser won't report that" is not a rule this can rely on.

export const OFFER_REGIONS = Object.freeze([
  '#portfolioContent',
  '#labsContent',
  '#projectDialog .project-dialog__description',
  'main p'
])

const MIN_CHARS = 12
const MAX_CHARS = 300

export function selectionOffer ({ text, withinRegion } = {}) {
  if (!OFFER_REGIONS.includes(withinRegion)) return { show: false, quote: '', reason: 'region-not-allowed' }
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (clean.length < MIN_CHARS) return { show: false, quote: '', reason: 'too-short' }
  // A quote is a VALUE, not an identity: clamp it, never drop it (invariant #17's rule).
  if (clean.length > MAX_CHARS) return { show: true, quote: clean.slice(0, MAX_CHARS - 1).trimEnd() + '…', reason: 'too-long' }
  return { show: true, quote: clean, reason: 'ok' }
}

/** Coarse length buckets: answers "do people use this?" without the text (§7.3). */
export function charBucket (n) {
  if (n < 50) return '1-49'
  if (n < 200) return '50-199'
  return '200+'
}
