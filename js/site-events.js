// site-events.js — first-party interaction beacon.
// Mirrors every GA event to our own backend so the daily report can reflect the
// TRUE, unsampled set of interactions (GA is kept for its dashboards; this is the
// owned copy). Events are buffered and flushed in small batches via sendBeacon
// (survives page unload) with a fetch keepalive fallback.

import { eventsApiUrl } from './site-config.js'

const SESSION_KEY = 'gvp-events-session'
const FLUSH_INTERVAL_MS = 4000
const MAX_BUFFER = 25

let buffer = []
let timer = null
let started = false
let fallbackSessionId = null

function getSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id =
        (crypto && crypto.randomUUID && crypto.randomUUID()) ||
        `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    if (!fallbackSessionId) {
      fallbackSessionId =
        (crypto && crypto.randomUUID && crypto.randomUUID()) ||
        `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    return fallbackSessionId
  }
}

function currentSection() {
  const hash = (window.location.hash || '').replace('#', '')
  return hash || 'home'
}

function post(payload) {
  if (!eventsApiUrl) return
  const body = JSON.stringify(payload)
  // Send as text/plain (a CORS-safelisted content type) so the cross-origin POST is
  // a "simple" request: no preflight. navigator.sendBeacon always uses credentials
  // mode "include"; a non-safelisted Content-Type (e.g. application/json) would
  // trigger a CORS preflight, which sendBeacon cannot send — the beacon would be
  // silently dropped. text/plain is CORS-safelisted so the POST stays simple and
  // no preflight is needed; the server JSON.parses the body regardless of content-type.
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' })
      if (navigator.sendBeacon(eventsApiUrl, blob)) return
    }
  } catch {
    /* fall through to fetch */
  }
  try {
    fetch(eventsApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      keepalive: true,
      credentials: 'omit'
    }).catch(() => {})
  } catch {
    /* best-effort: analytics must never break the page */
  }
}

export function flushEvents() {
  if (!buffer.length) return
  const events = buffer
  buffer = []
  post({ sessionId: getSessionId(), events })
}

function scheduleFlush() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    flushEvents()
  }, FLUSH_INTERVAL_MS)
}

// Record one interaction. Safe to call before init; it simply buffers.
export function recordEvent(eventName, params = {}) {
  if (!eventName) return
  buffer.push({
    event: String(eventName),
    params: params && typeof params === 'object' ? params : {},
    page: window.location.pathname + window.location.hash,
    section: params.section || currentSection(),
    ts: Date.now()
  })
  if (buffer.length >= MAX_BUFFER) flushEvents()
  else scheduleFlush()
}

export function initSiteEvents() {
  if (started || !eventsApiUrl) return
  started = true
  // Flush on the way out so the last interactions of a visit aren't lost.
  const flushNow = () => flushEvents()
  window.addEventListener('pagehide', flushNow)
  window.addEventListener('beforeunload', flushNow)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow()
  })
}
