const CHAT_FLAGS = [
  'no_retrieval_match',
  'negative_feedback',
  'possible_refusal',
  'long_conversation',
  'tool_offered_not_taken'
]

const contactApiBase = String(window.__CONTACT_API_URL__ || '').replace(/\/+$/, '')
const contactAdminBaseUrl =
  window.__ADMIN_API_BASE_URL__ ||
  (contactApiBase ? `${contactApiBase}/admin` : '')
const apiRoot = contactApiBase.endsWith('/api/contact')
  ? contactApiBase.slice(0, -'/api/contact'.length)
  : ''
// Same API host as contact admin; never use site-relative /api/chat/admin unless we have no absolute base.
let chatAdminBaseUrl = '/api/chat/admin'
if (contactAdminBaseUrl && /\/api\/contact\/admin\/?$/.test(contactAdminBaseUrl)) {
  chatAdminBaseUrl = contactAdminBaseUrl.replace(/\/api\/contact\/admin\/?$/, '/api/chat/admin')
} else if (apiRoot) {
  chatAdminBaseUrl = `${apiRoot}/api/chat/admin`
}
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

const tabContactBtn = document.getElementById('adminTabContact')
const tabTranscriptsBtn = document.getElementById('adminTabTranscripts')
const panelContact = document.getElementById('adminPanelContact')
const panelTranscripts = document.getElementById('adminPanelTranscripts')

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
const loadMoreBtn = document.getElementById('adminLoadMoreBtn')

const chatSummaryEls = {
  total: document.getElementById('chatSummaryTotal'),
  reviewed: document.getElementById('chatSummaryReviewed'),
  unreviewed: document.getElementById('chatSummaryUnreviewed'),
  flagged: document.getElementById('chatSummaryFlagged')
}
const chatLimitEl = document.getElementById('chatAdminLimit')
const chatTable = document.getElementById('chatTranscriptsTable')
const chatLoadMoreBtn = document.getElementById('chatLoadMoreBtn')
const chatReviewedFilters = document.getElementById('chatReviewedFilters')
const chatFlagFilters = document.getElementById('chatFlagFilters')
const chatPromptVersionFilter = document.getElementById('chatPromptVersionFilter')
const chatMetaEl = document.getElementById('chatTranscriptMeta')
const chatTurnsEl = document.getElementById('chatTranscriptTurns')
const chatNoteEl = document.getElementById('chatTranscriptNote')
const chatSaveNoteBtn = document.getElementById('chatSaveNoteBtn')
const chatMarkReviewedBtn = document.getElementById('chatMarkReviewedBtn')
const chatMarkUnreviewedBtn = document.getElementById('chatMarkUnreviewedBtn')

let activeTab = 'contact'
let adminKey = sessionStorage.getItem('admin-api-key') || ''
let selectedMessageId = null
let currentMessages = []
let selectedDetailItem = null
let messageBodyVisible = false
let messagesNextCursor = ''

let chatSelectedId = null
let chatCurrentItems = []
let chatNextCursor = ''
let chatSelectedItem = null
let chatHasLoaded = false
const chatFilters = {
  reviewed: '',
  promptVersion: '',
  flags: new Set()
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

function flagLabel(flag) {
  return flag
    .split('_')
    .map((part) => `${part[0] || ''}${part.slice(1)}`)
    .join(' ')
}

async function request(baseUrl, path, options = {}) {
  const url = `${baseUrl}${path}`
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

function requestContact(path, options = {}) {
  return request(contactAdminBaseUrl, path, options)
}

function requestChat(path, options = {}) {
  return request(chatAdminBaseUrl, path, options)
}

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

async function loadContactDashboard() {
  setStatus(globalStatus, 'Loading contact dashboard…')
  try {
    const limit = Number(limitEl.value || 25)
    messagesNextCursor = ''
    if (loadMoreBtn) loadMoreBtn.hidden = true
    const [summary, messages, health] = await Promise.all([
      requestContact('/summary'),
      requestContact(`/messages?limit=${limit}`),
      requestContact('/health')
    ])

    renderSummary(summary)
    messagesNextCursor = messages.nextCursor || ''
    if (loadMoreBtn) loadMoreBtn.hidden = !messagesNextCursor
    renderMessages(messages.items || [])
    renderHealth(health)

    if (selectedMessageId) {
      const item = await requestContact(`/messages/${selectedMessageId}`)
      renderDetail(item)
    } else {
      renderDetail(null)
    }
    setStatus(globalStatus, 'Contact dashboard updated.', 'success')
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load contact dashboard.', 'error')
    if (/Unauthorized/i.test(String(error.message || ''))) {
      app.hidden = true
      authCard.hidden = false
      setStatus(authStatus, 'Admin key rejected.', 'error')
    }
  }
}

async function loadMoreMessages() {
  if (!messagesNextCursor || !loadMoreBtn) return
  setStatus(globalStatus, 'Loading older contact messages…')
  try {
    const limit = Number(limitEl.value || 25)
    const q = `/messages?limit=${limit}&cursor=${encodeURIComponent(messagesNextCursor)}`
    const body = await requestContact(q)
    const batch = body.items || []
    currentMessages = currentMessages.concat(batch)
    messagesNextCursor = body.nextCursor || ''
    if (loadMoreBtn) loadMoreBtn.hidden = !messagesNextCursor
    renderMessages(currentMessages)
    setStatus(globalStatus, 'Older messages loaded.', 'success')
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load more messages.', 'error')
  }
}

function renderChatSummary(summary) {
  chatSummaryEls.total.textContent = summary.total ?? 0
  chatSummaryEls.reviewed.textContent = summary.reviewed ?? 0
  chatSummaryEls.unreviewed.textContent = summary.unreviewed ?? 0
  chatSummaryEls.flagged.textContent = summary.flagged ?? 0
}

function refreshPromptVersionFilter(summary) {
  const selected = chatFilters.promptVersion || ''
  const versions = Object.keys(summary.byPromptVersion || {}).sort()
  chatPromptVersionFilter.innerHTML = [
    '<option value="">All versions</option>',
    ...versions.map((version) => `<option value="${escapeHtml(version)}">${escapeHtml(version)}</option>`)
  ].join('')
  chatPromptVersionFilter.value = selected
}

function renderChatTable(items) {
  chatCurrentItems = items
  if (!items.length) {
    chatTable.innerHTML = '<tr><td colspan="5">No transcripts match these filters.</td></tr>'
    return
  }
  chatTable.innerHTML = items.map((item) => {
    const flagNames = CHAT_FLAGS.filter((flag) => item.flags?.[flag]).map(flagLabel)
    return `
      <tr data-id="${escapeHtml(item.id)}" class="${item.id === chatSelectedId ? 'is-selected' : ''}">
        <td>${escapeHtml(formatDate(item.updatedAt || item.createdAt))}</td>
        <td>${escapeHtml(item.promptVersion || 'unknown')}</td>
        <td>${escapeHtml(item.turnCount || 0)}</td>
        <td>${item.reviewed ? 'Yes' : 'No'}</td>
        <td>${escapeHtml(flagNames.join(', ') || '—')}</td>
      </tr>
    `
  }).join('')
}

function renderChatDetail(item) {
  chatSelectedItem = item || null
  const disabled = !item
  if (chatSaveNoteBtn) chatSaveNoteBtn.disabled = disabled
  if (chatMarkReviewedBtn) chatMarkReviewedBtn.disabled = disabled || item.reviewed
  if (chatMarkUnreviewedBtn) chatMarkUnreviewedBtn.disabled = disabled || !item.reviewed
  if (!item) {
    chatMetaEl.innerHTML = '<div><dt>Transcript</dt><dd>Select a transcript</dd></div>'
    chatTurnsEl.textContent = 'No transcript selected.'
    chatNoteEl.value = ''
    return
  }

  const flagNames = CHAT_FLAGS.filter((flag) => item.flags?.[flag]).map(flagLabel)
  chatMetaEl.innerHTML = `
    <div><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div>
    <div><dt>Prompt version</dt><dd>${escapeHtml(item.promptVersion || 'unknown')}</dd></div>
    <div><dt>Reviewed</dt><dd>${item.reviewed ? 'Yes' : 'No'}</dd></div>
    <div><dt>Updated</dt><dd>${escapeHtml(formatDate(item.updatedAt || item.createdAt))}</dd></div>
    <div><dt>Turns</dt><dd>${escapeHtml(item.turnCount || 0)}</dd></div>
    <div><dt>Flags</dt><dd>${escapeHtml(flagNames.join(', ') || '—')}</dd></div>
  `
  chatNoteEl.value = item.adminNotes || ''

  const turns = Array.isArray(item.turns) ? item.turns : []
  if (!turns.length) {
    chatTurnsEl.textContent = 'No transcript turns captured.'
    return
  }
  chatTurnsEl.textContent = turns.map((turn, idx) => {
    const userMessages = (turn.requestMessages || [])
      .filter((m) => m.role === 'user')
      .map((m) => `- ${m.content}`)
      .join('\n')
    return [
      `Turn ${idx + 1} (${formatDate(turn.capturedAt)})`,
      'User messages:',
      userMessages || '- (none)',
      'Assistant:',
      String(turn.reply || '').trim() || '(empty)',
      ''
    ].join('\n')
  }).join('\n')
}

function chatQueryString() {
  const params = new URLSearchParams()
  params.set('limit', String(Number(chatLimitEl.value || 25)))
  if (chatFilters.reviewed) params.set('reviewed', chatFilters.reviewed)
  if (chatFilters.promptVersion) params.set('promptVersion', chatFilters.promptVersion)
  if (chatFilters.flags.size > 0) {
    params.set('flags', Array.from(chatFilters.flags).join(','))
  }
  return params.toString()
}

async function loadChatDashboard() {
  setStatus(globalStatus, 'Loading chat transcript dashboard…')
  try {
    chatNextCursor = ''
    if (chatLoadMoreBtn) chatLoadMoreBtn.hidden = true
    const [summary, listBody] = await Promise.all([
      requestChat('/transcripts/summary'),
      requestChat(`/transcripts?${chatQueryString()}`)
    ])
    renderChatSummary(summary)
    refreshPromptVersionFilter(summary)

    chatNextCursor = listBody.nextCursor || ''
    if (chatLoadMoreBtn) chatLoadMoreBtn.hidden = !chatNextCursor
    renderChatTable(listBody.items || [])

    if (chatSelectedId) {
      const detail = await requestChat(`/transcripts/${encodeURIComponent(chatSelectedId)}`)
      renderChatDetail(detail)
    } else {
      renderChatDetail(null)
    }
    chatHasLoaded = true
    setStatus(globalStatus, 'Chat transcript dashboard updated.', 'success')
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load transcripts.', 'error')
  }
}

async function loadMoreChatTranscripts() {
  if (!chatNextCursor || !chatLoadMoreBtn) return
  setStatus(globalStatus, 'Loading older transcripts…')
  try {
    const params = new URLSearchParams(chatQueryString())
    params.set('cursor', chatNextCursor)
    const body = await requestChat(`/transcripts?${params.toString()}`)
    const batch = body.items || []
    chatCurrentItems = chatCurrentItems.concat(batch)
    chatNextCursor = body.nextCursor || ''
    if (chatLoadMoreBtn) chatLoadMoreBtn.hidden = !chatNextCursor
    renderChatTable(chatCurrentItems)
    setStatus(globalStatus, 'Older transcripts loaded.', 'success')
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load older transcripts.', 'error')
  }
}

function setActiveTab(tab) {
  activeTab = tab === 'transcripts' ? 'transcripts' : 'contact'
  tabContactBtn.classList.toggle('is-active', activeTab === 'contact')
  tabTranscriptsBtn.classList.toggle('is-active', activeTab === 'transcripts')
  tabContactBtn.setAttribute('aria-selected', activeTab === 'contact' ? 'true' : 'false')
  tabTranscriptsBtn.setAttribute('aria-selected', activeTab === 'transcripts' ? 'true' : 'false')
  panelContact.hidden = activeTab !== 'contact'
  panelTranscripts.hidden = activeTab !== 'transcripts'
  if (activeTab === 'transcripts' && !chatHasLoaded) {
    void loadChatDashboard()
  }
}

authForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!contactAdminBaseUrl && !isLocalAdminHost) {
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
    await requestContact('/summary')
    authCard.hidden = true
    app.hidden = false
    setStatus(authStatus, '')
    await loadContactDashboard()
  } catch (error) {
    sessionStorage.removeItem('admin-api-key')
    setStatus(authStatus, error.message || 'Could not authenticate.', 'error')
  }
})

tabContactBtn?.addEventListener('click', () => setActiveTab('contact'))
tabTranscriptsBtn?.addEventListener('click', () => setActiveTab('transcripts'))

messagesTable?.addEventListener('click', async (event) => {
  const row = event.target.closest('tr[data-id]')
  if (!row) return
  selectedMessageId = row.dataset.id
  renderMessages(currentMessages)
  try {
    renderDetail(await requestContact(`/messages/${selectedMessageId}`))
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load message.', 'error')
  }
})

chatTable?.addEventListener('click', async (event) => {
  const row = event.target.closest('tr[data-id]')
  if (!row) return
  chatSelectedId = row.dataset.id
  renderChatTable(chatCurrentItems)
  try {
    renderChatDetail(await requestChat(`/transcripts/${encodeURIComponent(chatSelectedId)}`))
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not load transcript detail.', 'error')
  }
})

retryBtn?.addEventListener('click', async () => {
  if (!selectedMessageId) return
  if (!window.confirm('Retry this message?')) return
  try {
    await requestContact(`/retry/${selectedMessageId}`, { method: 'POST' })
    setStatus(globalStatus, 'Message requeued.', 'success')
    await loadContactDashboard()
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
    await requestContact(`/messages/${selectedMessageId}/suppress-report`, { method: 'POST' })
    setStatus(globalStatus, 'Daily report suppressed for this message.', 'success')
    await loadContactDashboard()
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not update report setting.', 'error')
  }
})

chatSaveNoteBtn?.addEventListener('click', async () => {
  if (!chatSelectedItem) return
  const note = String(chatNoteEl.value || '').slice(0, 4000)
  try {
    await requestChat(`/transcripts/${encodeURIComponent(chatSelectedItem.id)}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    })
    setStatus(globalStatus, 'Transcript note saved.', 'success')
    await loadChatDashboard()
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not save transcript note.', 'error')
  }
})

chatMarkReviewedBtn?.addEventListener('click', async () => {
  if (!chatSelectedItem) return
  try {
    await requestChat(`/transcripts/${encodeURIComponent(chatSelectedItem.id)}/reviewed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewed: true })
    })
    setStatus(globalStatus, 'Transcript marked reviewed.', 'success')
    await loadChatDashboard()
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not update reviewed state.', 'error')
  }
})

chatMarkUnreviewedBtn?.addEventListener('click', async () => {
  if (!chatSelectedItem) return
  try {
    await requestChat(`/transcripts/${encodeURIComponent(chatSelectedItem.id)}/reviewed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewed: false })
    })
    setStatus(globalStatus, 'Transcript marked unreviewed.', 'success')
    await loadChatDashboard()
  } catch (error) {
    setStatus(globalStatus, error.message || 'Could not update reviewed state.', 'error')
  }
})

refreshBtn?.addEventListener('click', () => {
  if (activeTab === 'transcripts') {
    void loadChatDashboard()
    return
  }
  void loadContactDashboard()
})

limitEl?.addEventListener('change', () => {
  void loadContactDashboard()
})
loadMoreBtn?.addEventListener('click', loadMoreMessages)
chatLimitEl?.addEventListener('change', () => {
  void loadChatDashboard()
})
chatLoadMoreBtn?.addEventListener('click', loadMoreChatTranscripts)

chatPromptVersionFilter?.addEventListener('change', () => {
  chatFilters.promptVersion = String(chatPromptVersionFilter.value || '')
  void loadChatDashboard()
})

chatReviewedFilters?.addEventListener('click', (event) => {
  const pill = event.target.closest('[data-reviewed]')
  if (!pill) return
  chatFilters.reviewed = String(pill.dataset.reviewed || '')
  for (const button of chatReviewedFilters.querySelectorAll('.admin-pill')) {
    button.classList.toggle('is-active', button === pill)
  }
  void loadChatDashboard()
})

chatFlagFilters?.addEventListener('click', (event) => {
  const pill = event.target.closest('[data-flag]')
  if (!pill) return
  const flag = String(pill.dataset.flag || '')
  if (!flag) return
  if (chatFilters.flags.has(flag)) {
    chatFilters.flags.delete(flag)
    pill.classList.remove('is-active')
  } else {
    chatFilters.flags.add(flag)
    pill.classList.add('is-active')
  }
  void loadChatDashboard()
})

signOutBtn?.addEventListener('click', () => {
  adminKey = ''
  selectedMessageId = null
  currentMessages = []
  messagesNextCursor = ''
  chatSelectedId = null
  chatCurrentItems = []
  chatNextCursor = ''
  chatSelectedItem = null
  chatHasLoaded = false
  chatFilters.reviewed = ''
  chatFilters.promptVersion = ''
  chatFilters.flags = new Set()
  if (loadMoreBtn) loadMoreBtn.hidden = true
  if (chatLoadMoreBtn) chatLoadMoreBtn.hidden = true
  sessionStorage.removeItem('admin-api-key')
  app.hidden = true
  authCard.hidden = false
  authInput.value = ''
  resetMessageBodyView()
  renderDetail(null)
  renderChatDetail(null)
  setActiveTab('contact')
  setStatus(globalStatus, '')
})

if (adminKey) {
  if (!contactAdminBaseUrl && !isLocalAdminHost) {
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
    setActiveTab('contact')
    void loadContactDashboard()
  }
}
