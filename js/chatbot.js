/**
 * Home hero chat — POST { messages } → { reply, model }
 * Uses window.__CHAT_API_URL__ (see index.html meta + inline script).
 */

const CHAT_DEFAULT_PATH = '/api/chat'

function _setPlaceholderVisible(placeholder, visible) {
  if (!placeholder) return
  placeholder.hidden = !visible
}

function _clearError(errorEl, retryBtn) {
  if (errorEl) {
    errorEl.textContent = ''
    errorEl.hidden = true
  }
  if (retryBtn) retryBtn.hidden = true
}

function _showError(errorEl, retryBtn, message) {
  if (errorEl) {
    errorEl.textContent = message
    errorEl.hidden = false
  }
  if (retryBtn) retryBtn.hidden = false
}

function _appendTurn(transcript, role, text) {
  const row = document.createElement('div')
  row.className = `hero-chat__turn hero-chat__turn--${role}`

  const label = document.createElement('div')
  label.className = 'hero-chat__turn-label'
  label.textContent = role === 'user' ? 'You' : 'Assistant'

  const body = document.createElement('div')
  body.className = 'hero-chat__turn-body'
  body.textContent = text

  row.append(label, body)
  transcript.appendChild(row)
  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
}

export function initChatbot() {
  const panel = document.getElementById('heroChatPanel')
  const transcript = document.getElementById('heroChatTranscript')
  const placeholder = document.getElementById('heroChatPlaceholder')
  const input = document.getElementById('heroChatInput')
  const sendBtn = document.getElementById('heroChatSend')
  const retryBtn = document.getElementById('heroChatRetry')
  const errorEl = document.getElementById('heroChatError')
  const statusEl = document.getElementById('heroChatStatus')

  if (!panel || !transcript || !input || !sendBtn) return

  const endpoint = window.__CHAT_API_URL__ || CHAT_DEFAULT_PATH
  /** @type {{ role: string, content: string }[]} */
  let messages = []
  let inflight = false

  const setBusy = (busy) => {
    inflight = busy
    panel.setAttribute('aria-busy', busy ? 'true' : 'false')
    input.disabled = busy
    sendBtn.disabled = busy
    if (retryBtn) retryBtn.disabled = busy
  }

  const humanizeError = (res, body) => {
    if (res.status === 429) return 'Service busy, try again in a moment.'
    if (res.status >= 500) return 'Service busy, try again.'
    if (body && typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim()
    }
    if (res.status === 413 || res.status === 400) {
      return 'Could not send that message. Try shortening it.'
    }
    return 'Something went wrong. Try again.'
  }

  const renderAssistantMeta = (model) => {
    if (!statusEl) return
    if (model && String(model).trim()) {
      statusEl.textContent = `Model: ${String(model).trim()}`
      statusEl.hidden = false
    } else {
      statusEl.textContent = ''
      statusEl.hidden = true
    }
  }

  const clearAssistantMeta = () => {
    if (!statusEl) return
    statusEl.textContent = ''
    statusEl.hidden = true
  }

  const syncPlaceholder = () => {
    _setPlaceholderVisible(placeholder, transcript.childElementCount === 0)
  }

  const postChat = async (payloadMessages) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payloadMessages })
    })

    const text = await res.text()
    let body = {}
    if (text) {
      try {
        body = JSON.parse(text)
      } catch (_) {
        body = {}
      }
    }

    if (!res.ok) {
      throw new Error(humanizeError(res, body))
    }

    const reply = body && typeof body.reply === 'string' ? body.reply : ''
    const model = body && typeof body.model === 'string' ? body.model : ''
    return { reply, model }
  }

  const completeAssistantReply = (reply, model) => {
    const safeReply = reply || '…'
    messages = messages.concat([{ role: 'assistant', content: safeReply }])
    _appendTurn(transcript, 'assistant', safeReply)
    renderAssistantMeta(model)
    syncPlaceholder()
  }

  const send = async () => {
    const text = String(input.value || '').trim()
    if (!text || inflight) return

    if (errorEl && !errorEl.hidden && messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last.role === 'user') {
        messages.pop()
        const lastEl = transcript.lastElementChild
        if (lastEl?.classList.contains('hero-chat__turn--user')) {
          transcript.removeChild(lastEl)
        }
        syncPlaceholder()
      }
    }

    _clearError(errorEl, retryBtn)
    clearAssistantMeta()

    messages = messages.concat([{ role: 'user', content: text }])
    _setPlaceholderVisible(placeholder, false)
    _appendTurn(transcript, 'user', text)
    input.value = ''

    setBusy(true)
    try {
      const { reply, model } = await postChat(messages)
      completeAssistantReply(reply, model)
    } catch (e) {
      let msg = 'Network error. Retry last message.'
      if (e instanceof Error && e.message) {
        const m = e.message
        if (!/failed to fetch|networkerror|load failed|fetch/i.test(m)) msg = m
      }
      if (!/retry/i.test(msg)) {
        msg = `${msg} Use "Retry last message" to try again.`
      }
      _showError(errorEl, retryBtn, msg)
    } finally {
      setBusy(false)
    }
  }

  const retryPost = async () => {
    if (inflight || messages.length === 0) return
    const last = messages[messages.length - 1]
    if (last.role !== 'user') return

    _clearError(errorEl, retryBtn)
    clearAssistantMeta()
    setBusy(true)
    try {
      const { reply, model } = await postChat(messages)
      completeAssistantReply(reply, model)
    } catch (e) {
      let msg = 'Network error. Retry last message.'
      if (e instanceof Error && e.message) {
        const m = e.message
        if (!/failed to fetch|networkerror|load failed|fetch/i.test(m)) msg = m
      }
      if (!/retry/i.test(msg)) {
        msg = `${msg} Retry last message and try again.`
      }
      _showError(errorEl, retryBtn, msg)
    } finally {
      setBusy(false)
    }
  }

  sendBtn.addEventListener('click', () => {
    void send()
  })

  retryBtn?.addEventListener('click', () => {
    void retryPost()
  })

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    void send()
  })

  syncPlaceholder()
}
