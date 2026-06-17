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
