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

function readChatVoiceFeatureEnabled() {
  const m = document.querySelector('meta[name="gvp:chat-voice-enabled"]')
  const raw = (m && m.getAttribute('content') || '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

export const contactApiUrl = resolveApiUrl('gvp:contact-api-url', '/api/contact')
export const chatApiUrl = resolveApiUrl('gvp:chat-api-url', '/api/chat')
export const chatVoiceFeatureEnabled = readChatVoiceFeatureEnabled()

if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.dataset.gvpChatVoice = chatVoiceFeatureEnabled ? '1' : '0'
}

if (typeof window !== 'undefined') {
  window.__CONTACT_API_URL__ = contactApiUrl
  window.__CHAT_API_URL__ = chatApiUrl
}
