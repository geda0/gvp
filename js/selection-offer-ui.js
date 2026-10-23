// M4 slice 16 (ADR-0017 §7.2-7.4) — the DOM glue for selection offers.
// Its ONE sink is the injected `openDraft` (js/chat.js's openPanelWithDraft): the quote lands in
// a visible, editable composer and reaches the network only when the visitor presses send. This
// module must never reference the submitting entry point - pinned by test/selection-offer.test.mjs.
// Analytics get { chars: <bucket>, section } and nothing else (§7.3).
import { selectionOffer, charBucket, OFFER_REGIONS } from './selection-offer.js'

export function initSelectionOffers ({ doc = document, getSelection = () => window.getSelection(), openDraft, track, getSection = () => '' } = {}) {
  if (typeof openDraft !== 'function') return
  const send = typeof track === 'function' ? track : () => {}
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'selection-offer'
  button.textContent = 'Ask about this'
  button.hidden = true
  button.setAttribute('aria-label', 'Ask the assistant about the selected text')
  doc.body.appendChild(button)

  let current = null
  const hide = () => { button.hidden = true; current = null }

  const regionOf = (sel) => {
    const node = sel && sel.anchorNode
    const el = node && (node.parentElement || node)
    if (!el || typeof el.closest !== 'function') return null
    return OFFER_REGIONS.find((selector) => el.closest(selector)) || null
  }

  const evaluate = () => {
    const sel = getSelection()
    if (!sel || !sel.rangeCount) return hide()
    const offer = selectionOffer({ text: sel.toString(), withinRegion: regionOf(sel) })
    if (!offer.show) return hide()
    current = offer.quote
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    button.style.left = `${Math.round(rect.left + rect.width / 2)}px`
    button.style.top = `${Math.round(rect.bottom + 8)}px`
    button.hidden = false
    send('selection_assistant_offer', { chars: charBucket(current.length), section: getSection() })
  }

  // The tap on the offer itself ends in a mouseup that bubbles here; re-evaluating then would
  // count a second offer for the one the visitor is taking.
  doc.addEventListener('mouseup', (e) => { if (e && e.target === button) return; evaluate() })
  doc.addEventListener('keyup', (e) => { if (e && e.shiftKey) evaluate() })
  doc.addEventListener('scroll', hide, true)

  button.addEventListener('mousedown', (e) => e.preventDefault()) // keep the selection alive
  button.addEventListener('click', (e) => {
    if (e && e.preventDefault) e.preventDefault()
    const quote = current
    hide()
    if (!quote) return
    send('selection_assistant_chip', { chars: charBucket(quote.length), section: getSection() })
    // A complete sentence: openPanelWithDraft trims, so a trailing separator would be lost.
    openDraft(`Tell me more about this: "${quote}"`)
  })
}
