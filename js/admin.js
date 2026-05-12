const contactApiBase = String(window.__CONTACT_API_URL__ || '').replace(/\/+$/, '')
const adminBaseUrl =
  window.__ADMIN_API_BASE_URL__ ||
  (contactApiBase ? `${contactApiBase}/admin` : '')
const trafficApiBaseUrl =
  window.__TRAFFIC_API_BASE_URL__ ||
  (adminBaseUrl ? `${String(adminBaseUrl).replace(/\/+$/, '')}/traffic` : '')
const trafficReportEmbedUrl = String(window.__TRAFFIC_REPORT_EMBED_URL__ || '').trim()
const isLocalAdminHost =
  typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')

const authCard = document.getElementById('adminAuthCard')
const authForm = document.getElementById('adminAuthForm')
const authInput = document.getElementById('adminKey')
const authStatus = document.getElementById('adminAuthStatus')
const app = document.getElementById('adminApp')
const globalStatus = document.getElementById('adminGlobalStatus')
const refreshBtn = document.getElementById('adminRefreshBtn')
const signOutBtn = document.getElementById('adminSignOutBtn')
const retryBtn = document.getElementById('adminRetryBtn')
const showMessageBtn = document.getElementById('adminShowMessageBtn')
const clearReportBtn = document.getElementById('adminClearReportBtn')
const messageBodyEl = document.getElementById('adminMessageBody')
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
const trafficPlaceholderEl = document.getElementById('adminTrafficPlaceholder')
const trafficFrameWrapEl = document.getElementById('adminTrafficFrameWrap')
const trafficFrameEl = document.getElementById('adminTrafficFrame')
const trafficDaysEl = document.getElementById('adminTrafficDays')
const trafficGeoTableEl = document.getElementById('adminTrafficGeoTable')
const trafficExitTableEl = document.getElementById('adminTrafficExitTable')
const trafficSessionsTableEl = document.getElementById('adminTrafficSessionsTable')
const trafficSessionMetaEl = document.getElementById('adminTrafficSessionMeta')
const trafficSessionEventsEl = document.getElementById('adminTrafficSessionEvents')
const trafficMetricEls = {
  sessions: document.getElementById('trafficSessions'),
  users: document.getElementById('trafficUsers'),
  avgPageviews: document.getElementById('trafficAvgPageviews'),
  avgEngagement: document.getElementById('trafficAvgEngagement'),
  estimatedHumans: document.getElementById('trafficEstimatedHumans'),
  estimatedBots: document.getElementById('trafficEstimatedBots'),
  bounceSessions: document.getElementById('trafficBounceSessions'),
  engagedSessions: document.getElementById('trafficEngagedSessions')
}

let adminKey = sessionStorage.getItem('admin-api-key') || ''
let selectedMessageId = null
let currentMessages = []
let selectedDetailItem = null
let messageBodyVisible = false
let selectedTrafficSessionKey = null
let currentTrafficSessions = []

function resetMessageBodyView() {
  messageBodyVisible = false
  if (messageBodyEl) {
    messageBodyEl.hidden = true
    messageBodyEl.textContent = ''
  }
  if (showMessageBtn) showMessageBtn.textContent = 'Show message'
}

function eligibleForDailyReport(item) {
  if (!item || item.status === 'sent') return false
  return (item.attempts || 0) > 0
}

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

function initTrafficEmbed() {
  if (!trafficPlaceholderEl || !trafficFrameWrapEl || !trafficFrameEl) return
  if (!trafficReportEmbedUrl) {
    trafficFrameWrapEl.hidden = true
    trafficFrameEl.removeAttribute('src')
    trafficPlaceholderEl.hidden = false
    return
  }

  trafficFrameWrapEl.hidden = false
  trafficPlaceholderEl.hidden = true
  if (trafficFrameEl.src !== trafficReportEmbedUrl) {
    trafficFrameEl.src = trafficReportEmbedUrl
  }
}

async function request(path, options = {}) {
  const url = `${adminBaseUrl}${path}`
  const response = await fetch(url, {
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

async function requestTraffic(path, options = {}) {
  const url = `${trafficApiBaseUrl}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'x-admin-key': adminKey
    }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body?.error || `Traffic request failed (${response.status})`)
  }
  return body
}

function formatNumber(value, digits = 0) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

function formatDurationMs(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0s'
  const totalSeconds = Math.round(n / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (!minutes) return `${seconds}s`
  return `${minutes}m ${seconds}s`
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

function renderTrafficSummary(summary) {
  if (!trafficMetricEls.sessions) return
  trafficMetricEls.sessions.textContent = formatNumber(summary.sessions)
  trafficMetricEls.users.textContent = formatNumber(summary.users)
  trafficMetricEls.avgPageviews.textContent = formatNumber(summary.avg_pageviews_per_session, 2)
  trafficMetricEls.avgEngagement.textContent = formatDurationMs(summary.avg_engagement_msec)
  trafficMetricEls.estimatedHumans.textContent = formatNumber(summary.estimated_human_sessions)
  trafficMetricEls.estimatedBots.textContent = formatNumber(summary.estimated_bot_sessions)
  trafficMetricEls.bounceSessions.textContent = formatNumber(summary.bounce_sessions)
  trafficMetricEls.engagedSessions.textContent = formatNumber(summary.engaged_sessions)
}

function renderTrafficGeo(items) {
  if (!trafficGeoTableEl) return
  if (!items.length) {
    trafficGeoTableEl.innerHTML = '<tr><td colspan="4">No geography data.</td></tr>'
    return
  }
  trafficGeoTableEl.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.country || 'Unknown')}</td>
        <td>${escapeHtml(item.region || 'Unknown')}</td>
        <td>${escapeHtml(item.city || 'Unknown')}</td>
        <td>${escapeHtml(formatNumber(item.sessions))}</td>
      </tr>
    `
    )
    .join('')
}

function renderTrafficExitPages(items) {
  if (!trafficExitTableEl) return
  if (!items.length) {
    trafficExitTableEl.innerHTML = '<tr><td colspan="2">No exit-page data.</td></tr>'
    return
  }
  trafficExitTableEl.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.exit_page || '(no page)')}</td>
        <td>${escapeHtml(formatNumber(item.sessions))}</td>
      </tr>
    `
    )
    .join('')
}

function renderTrafficSessionMeta(item) {
  if (!trafficSessionMetaEl) return
  if (!item) {
    trafficSessionMetaEl.innerHTML = '<div><dt>Session key</dt><dd>Select a session</dd></div>'
    return
  }
  trafficSessionMetaEl.innerHTML = `
    <div><dt>Session key</dt><dd>${escapeHtml(item.session_key)}</dd></div>
    <div><dt>User pseudo ID</dt><dd>${escapeHtml(item.user_pseudo_id)}</dd></div>
    <div><dt>Started</dt><dd>${escapeHtml(formatDate(item.session_start))}</dd></div>
    <div><dt>Ended</dt><dd>${escapeHtml(formatDate(item.session_end))}</dd></div>
    <div><dt>Country/City</dt><dd>${escapeHtml(item.country || 'Unknown')} / ${escapeHtml(item.city || 'Unknown')}</dd></div>
    <div><dt>Exit page</dt><dd>${escapeHtml(item.exit_page || '(no page)')}</dd></div>
    <div><dt>Events</dt><dd>${escapeHtml(formatNumber(item.events_count))}</dd></div>
    <div><dt>Bot likelihood</dt><dd>${escapeHtml(item.bot_likelihood || 'unknown')}</dd></div>
  `
}

function renderTrafficSessions(items) {
  currentTrafficSessions = items
  if (!trafficSessionsTableEl) return
  if (!items.length) {
    trafficSessionsTableEl.innerHTML = '<tr><td colspan="5">No sessions for this window.</td></tr>'
    renderTrafficSessionMeta(null)
    if (trafficSessionEventsEl) {
      trafficSessionEventsEl.textContent = 'No sessions for this window.'
    }
    return
  }
  trafficSessionsTableEl.innerHTML = items
    .map(
      (item) => `
      <tr data-session-key="${escapeHtml(item.session_key)}" class="${
        item.session_key === selectedTrafficSessionKey ? 'is-selected' : ''
      }">
        <td>${escapeHtml(formatDate(item.session_start))}</td>
        <td>${escapeHtml(item.country || 'Unknown')} / ${escapeHtml(item.city || 'Unknown')}</td>
        <td>${escapeHtml(item.exit_page || '(no page)')}</td>
        <td>${escapeHtml(formatNumber(item.events_count))}</td>
        <td>${escapeHtml(item.bot_likelihood || 'unknown')}</td>
      </tr>
    `
    )
    .join('')
  const selectedItem = items.find((item) => item.session_key === selectedTrafficSessionKey) || null
  renderTrafficSessionMeta(selectedItem)
}

function renderTrafficSessionEvents(events) {
  if (!trafficSessionEventsEl) return
  if (!events.length) {
    trafficSessionEventsEl.textContent = 'No events found for this session and date window.'
    return
  }
  trafficSessionEventsEl.textContent = events
    .map(
      (event) =>
        [
          `${event.event_time || ''}  ${event.event_name || ''}`,
          `  section=${event.section || '-'} interaction=${event.interaction_type || '-'} theme=${event.theme || '-'}`,
          `  page=${event.page_location || '-'} title=${event.page_title || '-'}`,
          `  link=${event.link_url || '-'} project=${event.project_id || '-'}`,
          ''
        ].join('\n')
    )
    .join('\n')
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
  selectedDetailItem = item || null
  resetMessageBodyView()

  if (!item) {
    detailEl.innerHTML = '<div><dt>Status</dt><dd>Select a message</dd></div>'
    if (retryBtn) retryBtn.disabled = true
    if (showMessageBtn) showMessageBtn.disabled = true
    if (clearReportBtn) clearReportBtn.disabled = true
    return
  }

  const suppressed = Boolean(item.reportSuppressed)
  const eligible = eligibleForDailyReport(item)
  const reportLabel = suppressed
    ? 'Stopped'
    : eligible
      ? 'Included'
      : '—'

  if (retryBtn) retryBtn.disabled = item.status === 'sent'
  if (showMessageBtn) {
    showMessageBtn.disabled = !item.message
  }
  if (clearReportBtn) {
    clearReportBtn.disabled = !eligible || suppressed
  }

  detailEl.innerHTML = `
    <div><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div>
    <div><dt>Status</dt><dd>${escapeHtml(item.status || '—')}</dd></div>
    <div><dt>Created</dt><dd>${escapeHtml(formatDate(item.createdAt))}</dd></div>
    <div><dt>Delivered</dt><dd>${escapeHtml(formatDate(item.deliveredAt))}</dd></div>
    <div><dt>Attempts</dt><dd>${escapeHtml(item.attempts || 0)}</dd></div>
    <div><dt>Daily failure report</dt><dd>${escapeHtml(reportLabel)}</dd></div>
    <div><dt>Resend ID</dt><dd>${escapeHtml(item.resendId || '—')}</dd></div>
    <div><dt>Sender</dt><dd>${escapeHtml(item.name || '—')} &lt;${escapeHtml(item.email || '—')}&gt;</dd></div>
    <div><dt>Subject</dt><dd>${escapeHtml(item.subject || '—')}</dd></div>
    <div><dt>Last error</dt><dd>${escapeHtml(item.lastError || '—')}</dd></div>
    <div><dt>Message body</dt><dd>${item.message ? 'Hidden — use Show message to view.' : '—'}</dd></div>
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
    await loadTraffic()
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

async function loadTraffic() {
  const days = Number(trafficDaysEl?.value || 30)
  const [summary, geo, exits, sessions] = await Promise.all([
    requestTraffic(`/summary?days=${days}`),
    requestTraffic(`/geo?days=${days}&limit=12`),
    requestTraffic(`/exit-pages?days=${days}&limit=12`),
    requestTraffic(`/sessions?days=${days}&limit=30&offset=0`)
  ])
  renderTrafficSummary(summary)
  renderTrafficGeo(geo.items || [])
  renderTrafficExitPages(exits.items || [])
  renderTrafficSessions(sessions.items || [])

  if (selectedTrafficSessionKey) {
    const detail = await requestTraffic(
      `/sessions/${encodeURIComponent(selectedTrafficSessionKey)}?days=${days}`
    )
    renderTrafficSessionEvents(detail.events || [])
  } else {
    renderTrafficSessionEvents([])
  }
}

authForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!adminBaseUrl && !isLocalAdminHost) {
    setStatus(
      authStatus,
      'Admin API URL is not configured. Deploy with SYNC_API_URLS enabled so meta "gvp:contact-api-url" is populated.',
      'error'
    )
    return
  }
  adminKey = authInput.value.trim()
  sessionStorage.setItem('admin-api-key', adminKey)
  setStatus(authStatus, 'Checking access…')
  try {
    await request('/summary')
    authCard.hidden = true
    app.hidden = false
    initTrafficEmbed()
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

trafficSessionsTableEl?.addEventListener('click', async (event) => {
  const row = event.target.closest('tr[data-session-key]')
  if (!row) return
  selectedTrafficSessionKey = row.dataset.sessionKey || null
  renderTrafficSessions(currentTrafficSessions)
  try {
    const days = Number(trafficDaysEl?.value || 30)
    const detail = await requestTraffic(
      `/sessions/${encodeURIComponent(selectedTrafficSessionKey)}?days=${days}`
    )
    renderTrafficSessionEvents(detail.events || [])
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load session timeline.', 'error')
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

showMessageBtn?.addEventListener('click', () => {
  if (!selectedDetailItem?.message || !messageBodyEl) return
  messageBodyVisible = !messageBodyVisible
  if (messageBodyVisible) {
    messageBodyEl.textContent = selectedDetailItem.message
    messageBodyEl.hidden = false
    showMessageBtn.textContent = 'Hide message'
  } else {
    messageBodyEl.textContent = ''
    messageBodyEl.hidden = true
    showMessageBtn.textContent = 'Show message'
  }
})

clearReportBtn?.addEventListener('click', async () => {
  if (!selectedMessageId || !selectedDetailItem) return
  if (
    !window.confirm(
      'Stop including this message in the daily failure report email? You can still see it in this dashboard.'
    )
  ) {
    return
  }
  try {
    await request(`/messages/${selectedMessageId}/suppress-report`, { method: 'POST' })
    setStatus(globalStatus, 'Daily report suppressed for this message.', 'success')
    await loadDashboard()
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not update report setting.', 'error')
  }
})

refreshBtn?.addEventListener('click', loadDashboard)
limitEl?.addEventListener('change', loadDashboard)
trafficDaysEl?.addEventListener('change', loadDashboard)

signOutBtn?.addEventListener('click', () => {
  adminKey = ''
  selectedMessageId = null
  selectedTrafficSessionKey = null
  currentMessages = []
  currentTrafficSessions = []
  sessionStorage.removeItem('admin-api-key')
  app.hidden = true
  authCard.hidden = false
  authInput.value = ''
  resetMessageBodyView()
  renderDetail(null)
  setStatus(globalStatus, '')
})

if (adminKey) {
  if (!adminBaseUrl && !isLocalAdminHost) {
    setStatus(
      authStatus,
      'Admin API URL is not configured. Deploy with SYNC_API_URLS enabled so meta "gvp:contact-api-url" is populated.',
      'error'
    )
    sessionStorage.removeItem('admin-api-key')
  } else {
  authInput.value = adminKey
  authCard.hidden = true
  app.hidden = false
  initTrafficEmbed()
  loadDashboard()
  }
}
