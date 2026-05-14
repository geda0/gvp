import { trackEvent } from './analytics.js'
import { chatBus } from './chat-bus.js'

const CHAT_DEFAULT_PATH = '/api/chat'
const RESUME_URL = 'resume/Marwan_Elgendy_Resume_public.pdf'
const EV_COLLAPSE = 'gvp:site-chat-collapse'
const SESSION_KEY = 'gvp-chat-session-id'
const MAX_COMPOSER_HEIGHT = 128
const SUCCESS_IDLE_DELAY_MS = 700
const ERROR_IDLE_DELAY_MS = 2300

let collapseChat = () => {}
let syncChatLaunchersImpl = () => {}

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

function normalizeSection(section) {
  return section === 'playground' || section === 'portfolio' ? section : 'home'
}

export function syncChatLaunchers(section = 'home') {
  syncChatLaunchersImpl(section)
}

// Backward-compatible export while app wiring updates.
export function syncHeroChatSurface(section = 'home') {
  syncChatLaunchers(section)
}

export function initChat() {
  const heroChat = document.getElementById('heroChat')
  const heroForm = document.getElementById('heroChatForm')
  const heroInput = document.getElementById('heroChatInput')
  const suggestions = document.getElementById('heroChatSuggestions')
  const headerForm = document.getElementById('headerChatForm')
  const headerInput = document.getElementById('headerChatInput')
  const headerIconBtn = document.getElementById('headerChatIconBtn')

  const dialog = document.getElementById('chatDialog')
  const backdrop = dialog?.querySelector('.chat-dialog__backdrop')
  const closeBtn = dialog?.querySelector('.chat-dialog__close')
  const messagesEl = document.getElementById('chatMessages')
  const composer = document.getElementById('chatComposer')
  const composerInput = document.getElementById('chatComposerInput')
  const composerSend = composer?.querySelector('.chat-composer__send')
  const statusEl = document.getElementById('chatStatus')

  if (!heroChat || !heroForm || !heroInput || !headerForm || !headerInput || !headerIconBtn
    || !dialog || !messagesEl || !composer || !composerInput || !statusEl) return

  const endpoint = window.__CHAT_API_URL__ || CHAT_DEFAULT_PATH
  const state = {
    history: [],
    pending: false,
    lastFocus: null,
    sessionId: getOrCreateSessionId()
  }
  const launcherState = {
    section: 'home',
    heroVisible: true
  }
  let launcherObserver = null
  let lifecycleResetTimer = null

  const isOpen = () => !dialog.hidden

  const setHeaderLauncherVisibility = (visible, { immediate = false } = {}) => {
    headerForm.setAttribute('aria-hidden', visible ? 'false' : 'true')
    headerIconBtn.setAttribute('aria-hidden', visible ? 'false' : 'true')
    if (visible) {
      headerForm.removeAttribute('inert')
      headerIconBtn.removeAttribute('inert')
    } else {
      headerForm.setAttribute('inert', '')
      headerIconBtn.setAttribute('inert', '')
    }
    if (immediate) {
      headerForm.classList.toggle('header-chatbar--visible', visible)
      headerIconBtn.classList.toggle('header-chatbar-icon--visible', visible)
      return
    }
    requestAnimationFrame(() => {
      headerForm.classList.toggle('header-chatbar--visible', visible)
      headerIconBtn.classList.toggle('header-chatbar-icon--visible', visible)
    })
  }

  const syncHeaderLauncherPlaceholder = (section = 'home') => {
    headerInput.placeholder = section === 'home'
      ? 'Ask anything about my work…'
      : 'Ask about this project, or anything else…'
  }

  const updateLauncherVisibility = ({ immediate = false } = {}) => {
    const showHeaderLauncher = launcherState.section === 'home'
      ? !launcherState.heroVisible
      : true
    setHeaderLauncherVisibility(showHeaderLauncher, { immediate })
  }

  const setupLauncherObserver = () => {
    if (typeof IntersectionObserver !== 'function') {
      launcherState.heroVisible = false
      updateLauncherVisibility({ immediate: true })
      return
    }
    launcherObserver?.disconnect()
    launcherObserver = new IntersectionObserver((entries) => {
      const [entry] = entries
      if (!entry) return
      launcherState.heroVisible = entry.isIntersecting && entry.intersectionRatio >= 0.35
      updateLauncherVisibility()
    }, {
      root: null,
      rootMargin: '0px',
      threshold: [0, 0.2, 0.35, 0.6, 1]
    })
    launcherObserver.observe(heroChat)
  }

  syncChatLaunchersImpl = (section = 'home') => {
    const nextSection = normalizeSection(section)
    launcherState.section = nextSection
    if (nextSection === 'home') {
      const rect = heroChat.getBoundingClientRect()
      const vh = window.innerHeight || document.documentElement.clientHeight || 0
      launcherState.heroVisible = rect.bottom > 0 && rect.top < vh
    }
    syncHeaderLauncherPlaceholder(nextSection)
    updateLauncherVisibility({ immediate: true })
  }

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

  const clearLifecycleResetTimer = () => {
    if (!lifecycleResetTimer) return
    clearTimeout(lifecycleResetTimer)
    lifecycleResetTimer = null
  }

  const scheduleIdleLifecycle = (delayMs = 0, detail = {}) => {
    clearLifecycleResetTimer()
    lifecycleResetTimer = setTimeout(() => {
      chatBus.emit('idle', detail)
    }, Math.max(0, Number(delayMs) || 0))
  }

  const applyHeaderLifecycleState = (chatState) => {
    const targets = [headerForm, headerIconBtn]
    const states = ['sending', 'thinking', 'streaming', 'tool_call', 'error']
    targets.forEach((target) => {
      if (!target) return
      target.classList.remove('chat-lifecycle-active')
      states.forEach((stateName) => {
        target.classList.remove(`chat-lifecycle-${stateName.replace('_', '-')}`)
      })
      if (chatState === 'idle') return
      target.classList.add('chat-lifecycle-active')
      target.classList.add(`chat-lifecycle-${String(chatState).replace('_', '-')}`)
    })
  }

  chatBus.on((chatState) => {
    applyHeaderLifecycleState(chatState)
  })

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

  const resetConversation = ({ focusTarget = 'composer' } = {}) => {
    messagesEl.textContent = ''
    state.history = []
    state.sessionId = renewSessionId()
    setStatus('Started over with a fresh chat session.')
    composerInput.value = ''
    autosizeComposer()
    if (focusTarget === 'hero') {
      heroInput.focus()
      return
    }
    if (isOpen()) {
      composerInput.focus()
    }
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
    } else if (source === 'header') {
      trackEvent('header_chat_submit', { surface: 'header' })
    } else {
      trackEvent('chat_composer_submit', { surface: 'dialog' })
    }
    clearLifecycleResetTimer()
    chatBus.emit('sending', { source })

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
      chatBus.emit('thinking', { source })
      const { reply, model, actions } = await postChat(state.history)
      if (actions.length > 0) {
        chatBus.emit('tool_call', { source, actions })
      }
      chatBus.emit('streaming', { source, model })
      const safeReply = String(reply || '').trim() || 'I do not have a response yet. Please try again.'
      state.history = state.history.concat({ role: 'assistant', content: safeReply })
      finalizeAssistantMessage(pendingAssistant, safeReply, actions)
      setStatus(model ? `Model: ${model}` : '')
      scheduleIdleLifecycle(SUCCESS_IDLE_DELAY_MS, { source, model })
    } catch (error) {
      pendingAssistant.remove()
      setStatus(extractErrorMessage(error), 'error')
      chatBus.emit('error', { source, message: extractErrorMessage(error) })
      scheduleIdleLifecycle(ERROR_IDLE_DELAY_MS, { source })
    } finally {
      setComposerBusy(false)
      composerInput.focus()
    }
  }

  const openPanelWithMessage = (text, source = 'hero') => {
    openPanel()
    void sendMessage(text, source)
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
    openPanelWithMessage(text, 'hero')
  })

  headerInput.addEventListener('focus', () => {
    trackEvent('header_chat_focus', { surface: 'header' })
  })

  headerInput.addEventListener('click', () => {
    if (state.history.length > 0 && !isOpen()) {
      openPanel()
    }
  })

  headerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = String(headerInput.value || '').trim()
    if (!text) {
      openPanel()
      return
    }
    headerInput.value = ''
    openPanelWithMessage(text, 'header')
  })

  headerIconBtn.addEventListener('click', () => {
    trackEvent('header_chat_icon_open', { surface: 'header' })
    openPanel()
  })

  suggestions?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-prompt]')
    if (!chip) return
    const prompt = String(chip.getAttribute('data-prompt') || '').trim()
    if (!prompt) return
    trackEvent('hero_chat_chip', { prompt: chip.textContent || '' })
    openPanelWithMessage(prompt, 'hero')
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
      clearLifecycleResetTimer()
      chatBus.emit('idle', { source: 'chat-footer' })
    }
  })

  autosizeComposer()
  setupLauncherObserver()
  syncChatLaunchersImpl('home')
  chatBus.emit('idle', { source: 'chat-init' })
}
