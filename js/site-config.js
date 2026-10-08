// site-config.js — parse API base URLs from <meta> tags (see index.html).
// Run early via `import './site-config.js'` from app.js so modules see resolved URLs.
// Also sets window globals for admin and any legacy reads.

function resolveApiUrl(metaName, localFallback) {
  const m = document.querySelector(`meta[name="${metaName}"]`)
  const raw = (m && m.getAttribute('content') || '').trim()
  // Normalise to ONE spelling (project invariant 18). Trailing slashes AND interior
  // slash runs, because `//api/chat` misses CloudFront's exact `/api/chat` behavior
  // exactly as `/api/chat/` does and falls through to the buffered default origin:
  // still 200, still text/event-stream, still the right text, delivered all at once
  // with streaming silently dead. Two base-join idioms that produce it already exist
  // in aws/*.yaml, and scripts/sync-site-api-urls.mjs writes its argument in verbatim.
  // The scheme's own `//` is preserved by splitting it off first rather than with a
  // `(?<!:)` lookbehind: Safari gained lookbehind only in 16.4, and an unsupported one
  // is a parse-time SyntaxError that would take this whole module down with it.
  const trimmed = raw.replace(/\/+$/, '')
  const scheme = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\//i)
  const prefix = scheme ? scheme[0] : ''
  const cleaned = prefix + trimmed.slice(prefix.length).replace(/\/{2,}/g, '/')
  const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || ''
  const isLocal = host === 'localhost' || host === '127.0.0.1'
  return cleaned || (isLocal ? localFallback : '')
}

export const contactApiUrl = resolveApiUrl('gvp:contact-api-url', '/api/contact')
export const chatApiUrl = resolveApiUrl('gvp:chat-api-url', '/api/chat')
// First-party analytics shares the contact HTTP API; the events route lives
// beside /api/contact, so derive it instead of needing its own meta tag.
export const eventsApiUrl = contactApiUrl
  ? contactApiUrl.replace(/\/api\/contact$/, '/api/events')
  : ''

if (typeof window !== 'undefined') {
  window.__CONTACT_API_URL__ = contactApiUrl
  window.__CHAT_API_URL__ = chatApiUrl
  window.__EVENTS_API_URL__ = eventsApiUrl
}
