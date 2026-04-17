const adminBaseUrl =
  window.__ADMIN_API_BASE_URL__ ||
  `${String(window.__CONTACT_API_URL__ || '').replace(/\/$/, '')}/admin`

const authCard = document.getElementById('adminAuthCard')
const authForm = document.getElementById('adminAuthForm')
const authInput = document.getElementById('adminKey')
const authStatus = document.getElementById('adminAuthStatus')
const app = document.getElementById('adminApp')
const globalStatus = document.getElementById('adminGlobalStatus')
const refreshBtn = document.getElementById('adminRefreshBtn')
const signOutBtn = document.getElementById('adminSignOutBtn')
const retryBtn = document.getElementById('adminRetryBtn')
const messagesTable = document.getElementById('adminMessagesTable')
const summaryEls = {
  total: document.getElementById('summaryTotal'),
  queued: document.getElementById('summaryQueued'),
  sending: document.getElementById('summarySending'),
  sent: document.getElementById('summarySent'),
  failed: document.getElementById('summaryFailed'),
  deadLettered: document.getElementById('summaryDeadLettered')
}
const detailEl = document.getElementById('adminMessageDetail')
const healthEl = document.getElementById('adminHealthDetail')
const outcomeEl = document.getElementById('adminOutcomeDetail')
const limitEl = document.getElementById('adminLimit')

let adminKey = sessionStorage.getItem('admin-api-key') || ''
let selectedMessageId = null
let currentMessages = []

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function setStatus(el, text, tone = 'muted') {
  el.textContent = text
  el.dataset.tone = tone
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function request(path, options = {}) {
  const response = await fetch(`${adminBaseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'x-admin-key': adminKey
    }
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body?.error || `Request failed (${response.status})`)
  }
  return body
}

function renderSummary(summary) {
  summaryEls.total.textContent = summary.total ?? 0
  summaryEls.queued.textContent = summary.queued ?? 0
  summaryEls.sending.textContent = summary.sending ?? 0
  summaryEls.sent.textContent = summary.sent ?? 0
  summaryEls.failed.textContent = summary.failed ?? 0
  summaryEls.deadLettered.textContent = summary.deadLettered ?? 0

  outcomeEl.innerHTML = `
    <div><dt>Most recent success</dt><dd>${summary.mostRecentSuccess ? `${escapeHtml(formatDate(summary.mostRecentSuccess.deliveredAt))} · ${escapeHtml(summary.mostRecentSuccess.email)}` : '—'}</dd></div>
    <div><dt>Most recent failure</dt><dd>${summary.mostRecentFailure ? `${escapeHtml(formatDate(summary.mostRecentFailure.createdAt))} · ${escapeHtml(summary.mostRecentFailure.lastError || '—')}` : '—'}</dd></div>
  `
}

function renderHealth(health) {
  healthEl.innerHTML = `
    <div><dt>API configured</dt><dd>${health.apiConfigured ? 'Yes' : 'No'}</dd></div>
    <div><dt>Queue visible</dt><dd>${health.queueVisible}</dd></div>
    <div><dt>Queue in flight</dt><dd>${health.queueInFlight}</dd></div>
    <div><dt>DLQ visible</dt><dd>${health.dlqVisible}</dd></div>
    <div><dt>Alarm state</dt><dd>${health.alarmState}</dd></div>
  `
}

function renderMessages(items) {
  currentMessages = items
  if (!items.length) {
    messagesTable.innerHTML = '<tr><td colspan="6">No messages found.</td></tr>'
    return
  }

  messagesTable.innerHTML = items.map((item) => `
    <tr data-id="${escapeHtml(item.id)}" class="${item.id === selectedMessageId ? 'is-selected' : ''}">
      <td>${escapeHtml(formatDate(item.createdAt))}</td>
      <td>${escapeHtml(item.name || '—')}<br><small>${escapeHtml(item.email || '—')}</small></td>
      <td>${escapeHtml(item.subject || '—')}</td>
      <td>${escapeHtml(item.status || '—')}</td>
      <td>${escapeHtml(item.attempts || 0)}</td>
      <td>${escapeHtml(item.lastError || '—')}</td>
    </tr>
  `).join('')
}

function renderDetail(item) {
  if (!item) {
    detailEl.innerHTML = '<div><dt>Status</dt><dd>Select a message</dd></div>'
    retryBtn.disabled = true
    return
  }

  retryBtn.disabled = item.status === 'sent'
  detailEl.innerHTML = `
    <div><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div>
    <div><dt>Status</dt><dd>${escapeHtml(item.status || '—')}</dd></div>
    <div><dt>Created</dt><dd>${escapeHtml(formatDate(item.createdAt))}</dd></div>
    <div><dt>Delivered</dt><dd>${escapeHtml(formatDate(item.deliveredAt))}</dd></div>
    <div><dt>Attempts</dt><dd>${escapeHtml(item.attempts || 0)}</dd></div>
    <div><dt>Resend ID</dt><dd>${escapeHtml(item.resendId || '—')}</dd></div>
    <div><dt>Sender</dt><dd>${escapeHtml(item.name || '—')} &lt;${escapeHtml(item.email || '—')}&gt;</dd></div>
    <div><dt>Subject</dt><dd>${escapeHtml(item.subject || '—')}</dd></div>
    <div><dt>Last error</dt><dd>${escapeHtml(item.lastError || '—')}</dd></div>
    <div><dt>Message</dt><dd>${escapeHtml(item.message || '—')}</dd></div>
  `
}

async function loadDashboard() {
  setStatus(globalStatus, 'Loading dashboard…')
  try {
    const limit = Number(limitEl.value || 25)
    const [summary, messages, health] = await Promise.all([
      request('/summary'),
      request(`/messages?limit=${limit}`),
      request('/health')
    ])

    renderSummary(summary)
    renderMessages(messages.items || [])
    renderHealth(health)

    if (selectedMessageId) {
      const item = await request(`/messages/${selectedMessageId}`)
      renderDetail(item)
    } else {
      renderDetail(null)
    }
    setStatus(globalStatus, 'Dashboard updated.', 'success')
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load dashboard.', 'error')
    if (/Unauthorized/i.test(String(error.message || ''))) {
      app.hidden = true
      authCard.hidden = false
      setStatus(authStatus, 'Admin key rejected.', 'error')
    }
  }
}

authForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  adminKey = authInput.value.trim()
  sessionStorage.setItem('admin-api-key', adminKey)
  setStatus(authStatus, 'Checking access…')
  try {
    await request('/summary')
    authCard.hidden = true
    app.hidden = false
    setStatus(authStatus, '')
    await loadDashboard()
  } catch (error) {
    sessionStorage.removeItem('admin-api-key')
    setStatus(authStatus, error.message || 'Could not authenticate.', 'error')
  }
})

messagesTable?.addEventListener('click', async (event) => {
  const row = event.target.closest('tr[data-id]')
  if (!row) return
  selectedMessageId = row.dataset.id
  renderMessages(currentMessages)
  try {
    renderDetail(await request(`/messages/${selectedMessageId}`))
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load message.', 'error')
  }
})

retryBtn?.addEventListener('click', async () => {
  if (!selectedMessageId) return
  if (!window.confirm('Retry this message?')) return
  try {
    await request(`/retry/${selectedMessageId}`, { method: 'POST' })
    setStatus(globalStatus, 'Message requeued.', 'success')
    await loadDashboard()
  } catch (error) {
    setStatus(globalStatus, error.message || 'Retry failed.', 'error')
  }
})

refreshBtn?.addEventListener('click', loadDashboard)
limitEl?.addEventListener('change', loadDashboard)

signOutBtn?.addEventListener('click', () => {
  adminKey = ''
  selectedMessageId = null
  currentMessages = []
  sessionStorage.removeItem('admin-api-key')
  app.hidden = true
  authCard.hidden = false
  authInput.value = ''
  renderDetail(null)
  setStatus(globalStatus, '')
})

if (adminKey) {
  authInput.value = adminKey
  authCard.hidden = true
  app.hidden = false
  loadDashboard()
}
