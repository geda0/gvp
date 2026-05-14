import { trackEvent } from './analytics.js'

const CHAT_DEFAULT_PATH = '/api/chat'
const RESUME_URL = 'resume/Marwan_Elgendy_Resume_public.pdf'
const EV_COLLAPSE = 'gvp:site-chat-collapse'
const SESSION_KEY = 'gvp-chat-session-id'
const MAX_COMPOSER_HEIGHT = 128

let collapseChat = () => {}

function createSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getOrCreateSessionId() {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY)
    if (existing) return existing
    const next = createSessionId()
    sessionStorage.setItem(SESSION_KEY, next)
    return next
  } catch (_) {
    return createSessionId()
  }
}

function renewSessionId() {
  const next = createSessionId()
  try {
    sessionStorage.setItem(SESSION_KEY, next)
  } catch (_) {
    // Ignore storage errors and keep in-memory session id
  }
  return next
}

function parsePrefill(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

function extractErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return 'Network error. Please try again.'
}

export function collapseChatDialog() {
  collapseChat()
}

export function initChat() {
  const heroForm = document.getElementById('heroChatForm')
  const heroInput = document.getElementById('heroChatInput')
  const suggestions = document.getElementById('heroChatSuggestions')

  const dialog = document.getElementById('chatDialog')
  const backdrop = dialog?.querySelector('.chat-dialog__backdrop')
  const closeBtn = dialog?.querySelector('.chat-dialog__close')
  const messagesEl = document.getElementById('chatMessages')
  const composer = document.getElementById('chatComposer')
  const composerInput = document.getElementById('chatComposerInput')
  const composerSend = composer?.querySelector('.chat-composer__send')
  const statusEl = document.getElementById('chatStatus')

  if (!heroForm || !heroInput || !dialog || !messagesEl || !composer || !composerInput || !statusEl) return

  const endpoint = window.__CHAT_API_URL__ || CHAT_DEFAULT_PATH
  const state = {
    history: [],
    pending: false,
    lastFocus: null,
    sessionId: getOrCreateSessionId()
  }

  const isOpen = () => !dialog.hidden

  const setStatus = (text, tone = 'muted') => {
    statusEl.textContent = text || ''
    if (!text || tone === 'muted') {
      delete statusEl.dataset.tone
      return
    }
    statusEl.dataset.tone = tone
  }

  const autosizeComposer = () => {
    composerInput.style.height = 'auto'
    const nextHeight = Math.min(composerInput.scrollHeight, MAX_COMPOSER_HEIGHT)
    composerInput.style.height = `${Math.max(nextHeight, 34)}px`
    composerInput.style.overflowY = composerInput.scrollHeight > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden'
  }

  const scrollMessagesToBottom = () => {
    const prefersReduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    messagesEl.scrollTo({
      top: messagesEl.scrollHeight,
      behavior: prefersReduced ? 'auto' : 'smooth'
    })
  }

  const createActionButton = (action) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chat-msg__action'
    button.dataset.action = action.id
    button.textContent = action.label
    if (action.prefill) {
      button.dataset.prefill = JSON.stringify(action.prefill)
    }
    return button
  }

  const appendMessage = (role, text, options = {}) => {
    const item = document.createElement('li')
    item.className = `chat-msg chat-msg--${role}`
    if (options.streaming) {
      item.classList.add('chat-msg--streaming')
    }

    const bubble = document.createElement('div')
    bubble.className = 'chat-msg__bubble'
    const body = document.createElement('p')
    body.className = 'chat-msg__text'
    body.textContent = text
    bubble.appendChild(body)

    if (options.streaming) {
      const cursor = document.createElement('span')
      cursor.className = 'chat-msg__cursor'
      cursor.setAttribute('aria-hidden', 'true')
      bubble.appendChild(cursor)
    }

    item.appendChild(bubble)

    if (Array.isArray(options.actions) && options.actions.length > 0) {
      const actionsWrap = document.createElement('div')
      actionsWrap.className = 'chat-msg__actions'
      options.actions.forEach((action) => {
        actionsWrap.appendChild(createActionButton(action))
      })
      item.appendChild(actionsWrap)
    }

    messagesEl.appendChild(item)
    scrollMessagesToBottom()
    return item
  }

  const finalizeAssistantMessage = (messageEl, text, actions) => {
    const textEl = messageEl.querySelector('.chat-msg__text')
    if (textEl) textEl.textContent = text

    messageEl.classList.remove('chat-msg--streaming')
    messageEl.querySelector('.chat-msg__cursor')?.remove()
    messageEl.querySelector('.chat-msg__actions')?.remove()

    if (Array.isArray(actions) && actions.length > 0) {
      const actionsWrap = document.createElement('div')
      actionsWrap.className = 'chat-msg__actions'
      actions.forEach((action) => actionsWrap.appendChild(createActionButton(action)))
      messageEl.appendChild(actionsWrap)
    }

    scrollMessagesToBottom()
  }

  const setComposerBusy = (busy) => {
    state.pending = busy
    composerInput.disabled = busy
    if (composerSend) composerSend.disabled = busy
  }

  const openPanel = () => {
    if (isOpen()) return
    state.lastFocus = document.activeElement
    dialog.hidden = false
    dialog.setAttribute('aria-hidden', 'false')
    document.body.classList.add('chat-dialog-open')
    requestAnimationFrame(() => {
      autosizeComposer()
      composerInput.focus()
    })
  }

  const closePanel = ({ restoreFocus = true } = {}) => {
    if (!isOpen()) return
    dialog.hidden = true
    dialog.setAttribute('aria-hidden', 'true')
    document.body.classList.remove('chat-dialog-open')
    setStatus('')
    if (restoreFocus && state.lastFocus && typeof state.lastFocus.focus === 'function') {
      state.lastFocus.focus()
    }
    state.lastFocus = null
  }

  collapseChat = () => closePanel({ restoreFocus: false })

  const openContactFromChat = (prefill) => {
    closePanel({ restoreFocus: false })
    document.getElementById('openContactBtn')?.click()
    if (!prefill || typeof prefill !== 'object') return

    requestAnimationFrame(() => {
      const form = document.getElementById('contactForm')
      if (!form) return

      const subject = form.querySelector('input[name="subject"]')
      const message = form.querySelector('textarea[name="message"]')
      if (subject && typeof prefill.subject === 'string') {
        subject.value = prefill.subject
        subject.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (message && typeof prefill.message === 'string') {
        message.value = prefill.message
        message.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
  }

  const resetConversation = () => {
    messagesEl.textContent = ''
    state.history = []
    state.sessionId = renewSessionId()
    setStatus('Started over with a fresh chat session.')
    composerInput.value = ''
    autosizeComposer()
    composerInput.focus()
  }

  const postChat = async (history) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        stream: false,
        sessionId: state.sessionId
      })
    })

    const text = await response.text()
    let body = {}
    if (text) {
      try {
        body = JSON.parse(text)
      } catch (_) {
        body = {}
      }
    }

    if (!response.ok) {
      const detail = body?.detail || body?.error
      if (response.status === 429) {
        throw new Error('Service is busy. Try again in a moment.')
      }
      if (typeof detail === 'string' && detail.trim()) {
        throw new Error(detail.trim())
      }
      throw new Error('Chat request failed. Try again.')
    }

    const reply = typeof body?.reply === 'string' ? body.reply : ''
    const model = typeof body?.model === 'string' ? body.model : ''
    const actions = Array.isArray(body?.actions) ? body.actions : []
    return { reply, model, actions }
  }

  const sendMessage = async (rawText, source = 'composer') => {
    const text = String(rawText || '').trim()
    if (!text) return

    if (state.pending) {
      setStatus('Assistant is still replying. Please wait.')
      return
    }

    if (source === 'hero') {
      trackEvent('hero_chat_submit', { surface: 'hero' })
    } else {
      trackEvent('chat_composer_submit', { surface: 'dialog' })
    }

    setStatus('')
    appendMessage('user', text)
    state.history = state.history.concat({ role: 'user', content: text })
    if (source === 'composer') {
      composerInput.value = ''
      autosizeComposer()
    }

    setComposerBusy(true)
    const pendingAssistant = appendMessage('assistant', '', { streaming: true })

    try {
      const { reply, model, actions } = await postChat(state.history)
      const safeReply = String(reply || '').trim() || 'I do not have a response yet. Please try again.'
      state.history = state.history.concat({ role: 'assistant', content: safeReply })
      finalizeAssistantMessage(pendingAssistant, safeReply, actions)
      setStatus(model ? `Model: ${model}` : '')
    } catch (error) {
      pendingAssistant.remove()
      setStatus(extractErrorMessage(error), 'error')
    } finally {
      setComposerBusy(false)
      composerInput.focus()
    }
  }

  const openPanelWithMessage = (text) => {
    openPanel()
    void sendMessage(text, 'hero')
  }

  heroInput.addEventListener('focus', () => {
    trackEvent('hero_chat_focus', { surface: 'hero' })
  })

  heroInput.addEventListener('click', () => {
    if (state.history.length > 0 && !isOpen()) {
      openPanel()
    }
  })

  heroForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = String(heroInput.value || '').trim()
    if (!text) return
    heroInput.value = ''
    openPanelWithMessage(text)
  })

  suggestions?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-prompt]')
    if (!chip) return
    const prompt = String(chip.getAttribute('data-prompt') || '').trim()
    if (!prompt) return
    trackEvent('hero_chat_chip', { prompt: chip.textContent || '' })
    openPanelWithMessage(prompt)
  })

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    void sendMessage(composerInput.value, 'composer')
  })

  composerInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void sendMessage(composerInput.value, 'composer')
  })

  composerInput.addEventListener('input', () => {
    autosizeComposer()
  })

  backdrop?.addEventListener('click', () => closePanel())
  closeBtn?.addEventListener('click', () => closePanel())

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return
    event.preventDefault()
    closePanel()
  })

  window.addEventListener(EV_COLLAPSE, () => {
    closePanel({ restoreFocus: false })
  })

  dialog.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]')
    if (!actionEl) return
    const action = actionEl.dataset.action
    if (action === 'open-resume') {
      window.open(RESUME_URL, '_blank', 'noopener,noreferrer')
      return
    }
    if (action === 'open-contact') {
      openContactFromChat(parsePrefill(actionEl.dataset.prefill))
      return
    }
    if (action === 'start-over') {
      resetConversation()
    }
  })

  autosizeComposer()
}
