// time-switcher-mode.js — pure layout helpers for the time-of-day control.
//
// Dependency-free and side-effect-free: no DOM, no imports. Unit-tested in
// node:test (mirrors theme-time.js / voice-resume-button.js style).

/**
 * Which layout mode to use for the time control given the viewport width.
 * Collapses to 'dropdown' at/below the 767px mobile breakpoint; 'inline' above
 * it. Non-finite or unknown width fails safe to 'inline' (never hides the control).
 *
 * @param {number} width  viewport width in pixels
 * @returns {'inline'|'dropdown'}
 */
export function timeControlMode(width) {
  const w = Number(width)
  if (!Number.isFinite(w)) return 'inline'
  return w <= 767 ? 'dropdown' : 'inline'
}

/**
 * Static accessible name for the dropdown trigger button.
 *
 * @param {{open?: boolean}} [opts]
 * @returns {string}
 */
export function timeTriggerLabel({ open } = {}) {
  return open ? 'Close time of day picker' : 'Open time of day picker'
}

/** Legacy theme-switcher “Auto” icon — static on the mobile dropdown trigger. */
export const TIME_TRIGGER_ICON_HTML =
  '<svg class="theme-icon theme-icon--auto" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
  '<path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>'
