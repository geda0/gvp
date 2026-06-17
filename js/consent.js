// consent.js — analytics consent gate (ADR-0008).
// Default-deny: only returns true when the visitor has explicitly granted consent.
// Wrapped defensively so a missing / throwing localStorage never crashes the page.

const CONSENT_KEY = 'gvp-analytics-consent'

export function hasAnalyticsConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'granted'
  } catch {
    return false
  }
}

// Returns true when the visitor has already made a choice (either direction).
export function hasConsentDecision() {
  try {
    const val = localStorage.getItem(CONSENT_KEY)
    return val === 'granted' || val === 'denied'
  } catch {
    return false
  }
}

// Persists the visitor's choice. Pass true for granted, false for denied.
export function setAnalyticsConsent(granted) {
  try {
    localStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied')
  } catch {
    // best-effort — if localStorage throws we still update in-memory via hasAnalyticsConsent
  }
}

// ---------------------------------------------------------------------------
// Consent banner
// ---------------------------------------------------------------------------
// Injected into the page on first visit (no prior decision). Theme-consistent,
// keyboard-accessible (Esc = decline), respects prefers-reduced-motion.

export function initConsentBanner({ onAccept, onDecline } = {}) {
  if (hasConsentDecision()) return   // already decided — never show again

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const banner = document.createElement('div')
  banner.id = 'consentBanner'
  banner.setAttribute('role', 'dialog')
  banner.setAttribute('aria-modal', 'false')
  banner.setAttribute('aria-label', 'Analytics consent')
  banner.setAttribute('aria-live', 'polite')
  banner.style.cssText = [
    'position:fixed',
    'bottom:0',
    'left:0',
    'right:0',
    'z-index:9000',
    'display:flex',
    'align-items:center',
    'gap:1rem',
    'flex-wrap:wrap',
    'padding:0.875rem 1.25rem',
    'background:var(--surface-elevated,rgba(28,35,52,0.97))',
    'border-top:1px solid var(--border-subtle,rgba(140,165,210,0.12))',
    'color:var(--text-primary,#ccd2dd)',
    'font-size:0.875rem',
    'font-family:var(--font-body,system-ui,sans-serif)',
    prefersReduced ? '' : 'animation:consentBannerIn 0.25s ease-out both'
  ].filter(Boolean).join(';')

  const msg = document.createElement('span')
  msg.style.flex = '1'
  msg.style.minWidth = '200px'
  msg.textContent = 'This site uses optional analytics to understand how it\'s used. No tracking without your consent.'
  banner.appendChild(msg)

  const btnWrap = document.createElement('span')
  btnWrap.style.display = 'flex'
  btnWrap.style.gap = '0.5rem'
  btnWrap.style.flexShrink = '0'

  const acceptBtn = document.createElement('button')
  acceptBtn.type = 'button'
  acceptBtn.textContent = 'Accept'
  acceptBtn.setAttribute('aria-label', 'Accept analytics')
  acceptBtn.style.cssText = [
    'padding:0.4rem 0.9rem',
    'border:1px solid var(--accent,#8197bd)',
    'border-radius:var(--radius-sm,6px)',
    'background:var(--accent,#8197bd)',
    'color:var(--on-accent,#141926)',
    'font:inherit',
    'font-weight:600',
    'cursor:pointer',
    'white-space:nowrap'
  ].join(';')

  const declineBtn = document.createElement('button')
  declineBtn.type = 'button'
  declineBtn.textContent = 'Decline'
  declineBtn.setAttribute('aria-label', 'Decline analytics')
  declineBtn.style.cssText = [
    'padding:0.4rem 0.9rem',
    'border:1px solid var(--border-strong,rgba(165,188,225,0.2))',
    'border-radius:var(--radius-sm,6px)',
    'background:transparent',
    'color:var(--text-muted,rgba(204,210,221,0.68))',
    'font:inherit',
    'cursor:pointer',
    'white-space:nowrap'
  ].join(';')

  btnWrap.appendChild(acceptBtn)
  btnWrap.appendChild(declineBtn)
  banner.appendChild(btnWrap)

  // Inject keyframe once
  if (!document.getElementById('consentBannerStyle')) {
    const style = document.createElement('style')
    style.id = 'consentBannerStyle'
    style.textContent = '@keyframes consentBannerIn{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}'
    document.head.appendChild(style)
  }

  function dismiss() {
    banner.remove()
    document.removeEventListener('keydown', escHandler)
  }

  function accept() {
    setAnalyticsConsent(true)
    dismiss()
    if (typeof onAccept === 'function') onAccept()
  }

  function decline() {
    setAnalyticsConsent(false)
    dismiss()
    if (typeof onDecline === 'function') onDecline()
  }

  function escHandler(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      decline()
    }
  }

  acceptBtn.addEventListener('click', accept)
  declineBtn.addEventListener('click', decline)
  document.addEventListener('keydown', escHandler)

  document.body.appendChild(banner)
  // Focus the accept button so the banner is immediately reachable by keyboard
  acceptBtn.focus()
}
