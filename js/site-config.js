// site-config.js — parse API base URLs from <meta> tags (see index.html).
// Run early via `import './site-config.js'` from app.js so modules see resolved URLs.
// Also sets window globals for admin and any legacy reads.

function resolveApiUrl(metaName, localFallback) {
  const m = document.querySelector(`meta[name="${metaName}"]`)
  const raw = (m && m.getAttribute('content') || '').trim()
  const cleaned = raw.replace(/\/+$/, '')
  const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || ''
  const isLocal = host === 'localhost' || host === '127.0.0.1'
  return cleaned || (isLocal ? localFallback : '')
}

export const contactApiUrl = resolveApiUrl('gvp:contact-api-url', '/api/contact')
export const chatApiUrl = resolveApiUrl('gvp:chat-api-url', '/api/chat')

if (typeof window !== 'undefined') {
  window.__CONTACT_API_URL__ = contactApiUrl
  window.__CHAT_API_URL__ = chatApiUrl
}

// Deep-link the voice greeting language via `?lang=ar` (and friends). Writes
// the pinned code to localStorage where chat-live.js picks it up and includes
// it in the POST body to /api/live/session — the backend then asks Gemini Live
// to open the spoken greeting in that language. Unrecognised codes are ignored
// server-side (falls back to "match the visitor's language").
try {
  const params = new URLSearchParams(window.location.search)
  const lang = (params.get('lang') || '').trim().toLowerCase().split('-')[0]
  if (lang && /^[a-z]{2}$/.test(lang)) {
    localStorage.setItem('gvp-chat-language', lang)
  }
} catch (_) { /* sandboxed localStorage / malformed URL — silent fallback */ }
