// config-bootstrap.js — classic (non-module) script.
// Parses API base URLs from <meta> tags and exposes them as window globals
// before the deferred app module runs. Consumers:
//   window.__CONTACT_API_URL__ — js/contact.js, js/admin.js
//   window.__CHAT_API_URL__    — js/chat.js, js/chat-live.js
// Behavior must stay identical to the previous inline <script> blocks:
// trim + strip trailing slashes from the meta content, and fall back to a
// localhost-only relative path when no URL is configured.
(function () {
  function resolveApiUrl(metaName, localFallback) {
    var m = document.querySelector('meta[name="' + metaName + '"]')
    var raw = (m && m.getAttribute('content') || '').trim()
    var cleaned = raw.replace(/\/+$/, '')
    var host = (window.location && window.location.hostname) || ''
    var isLocal = host === 'localhost' || host === '127.0.0.1'
    return cleaned || (isLocal ? localFallback : '')
  }

  window.__CONTACT_API_URL__ = resolveApiUrl('gvp:contact-api-url', '/api/contact')
  window.__CHAT_API_URL__ = resolveApiUrl('gvp:chat-api-url', '/api/chat')
})()
