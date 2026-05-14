// project-observer.js - Tracks which project card is most in view
// so the spaceman can surface contextual messaging.

// Minimum intersection ratio before a card is considered "in view".
const VISIBLE_RATIO_THRESHOLD = 0.1
// Threshold steps the IntersectionObserver fires on; finer steps near the
// low end so small visibility changes still update the tracked card.
const OBSERVER_THRESHOLDS = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1]

/**
 * Observe project cards and report the one most in view via onVisibleChange.
 *
 * @param {NodeList|Array} cards - project card elements to observe
 * @param {object} opts
 * @param {() => string} opts.getCurrentSection - returns 'playground' | 'portfolio' | other
 * @param {(card: Element|null) => void} opts.onVisibleChange - called with the best card (or null)
 * @returns {{ recompute: () => void, disconnect: () => void }}
 */
export function initProjectObserver(cards, { getCurrentSection, onVisibleChange }) {
  const ratios = new Map()
  let raf = 0

  function computeBest() {
    let best = { ratio: 0, card: null }
    ratios.forEach((ratio, card) => {
      if (ratio > best.ratio) {
        const section = card.closest('#playgroundContent')
          ? 'playground'
          : card.closest('#portfolioContent')
            ? 'portfolio'
            : null
        if (section === getCurrentSection()) best = { ratio, card }
      }
    })
    if (best.ratio < VISIBLE_RATIO_THRESHOLD || !best.card) {
      onVisibleChange(null)
      return
    }
    onVisibleChange(best.card)
  }

  function recompute() {
    computeBest()
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        ratios.set(entry.target, entry.intersectionRatio)
      })
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          computeBest()
        })
      }
    },
    { root: null, rootMargin: '0px', threshold: OBSERVER_THRESHOLDS }
  )

  cards.forEach((card) => observer.observe(card))

  function disconnect() {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    observer.disconnect()
    ratios.clear()
  }

  return { recompute, disconnect }
}
