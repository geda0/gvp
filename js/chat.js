import { trackEvent } from './analytics.js'
import { chatBus } from './chat-bus.js'
import { bindChatLiveVoice } from './chat-live.js'
import { PANEL_ANIM_MS, PANEL_ANIM_EASE } from './chat-panel-anim.js'

const CHAT_DEFAULT_PATH = '/api/chat'
const RESUME_URL = 'resume/Marwan_Elgendy_Resume_public.pdf'
const EV_COLLAPSE = 'gvp:site-chat-collapse'
/** Open chat dialog from decoupled surfaces (e.g. spaceman) without importing chat from those modules. */
export const EV_OPEN_CHAT = 'gvp:open-chat'
const SESSION_KEY = 'gvp-chat-session-id'
const MAX_COMPOSER_HEIGHT = 128
const SUCCESS_IDLE_DELAY_MS = 700
const ERROR_IDLE_DELAY_MS = 2300
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'

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

function isFinePointer() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia(FINE_POINTER_QUERY).matches
}

function launcherReadOnlyForDevice() {
  return !isFinePointer()
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

export function syncHeroChatSurface(section = 'home') {
  syncChatLaunchers(section)
}

export function initChat() {
  document.documentElement.style.setProperty('--gvp-chat-panel-anim-ms', `${PANEL_ANIM_MS}ms`)
  document.documentElement.style.setProperty('--gvp-chat-panel-anim-ease', PANEL_ANIM_EASE)

  const agentNode = document.getElementById('agentNode')
  const agentForm = agentNode?.querySelector('.agent-node__form')
  const agentInput = agentNode?.querySelector('.agent-node__input')
  const agentSend = agentNode?.querySelector('.agent-node__send')
  const heroSlotEl = document.getElementById('agentSlotHero')

  const dialog = document.getElementById('chatDialog')
  const panel = dialog?.querySelector('.chat-dialog__panel')
  const dialogHeader = dialog?.querySelector('.chat-dialog__header')
  const backdrop = dialog?.querySelector('.chat-dialog__backdrop')
  const closeBtn = dialog?.querySelector('.chat-dialog__close')
  const messagesEl = document.getElementById('chatMessages')
  const emptyStateEl = document.getElementById('chatEmptyState')
  const dialogSuggestions = document.getElementById('chatDialogSuggestions')
  const composer = document.getElementById('chatComposer')
  const composerInput = document.getElementById('chatComposerInput')
  const composerSend = composer?.querySelector('.chat-composer__send')
  const composerMic = document.getElementById('chatComposerMic')
  const composerClear = document.getElementById('chatComposerClear')
  const statusEl = document.getElementById('chatStatus')

  if (!agentNode || !agentForm || !agentInput || !heroSlotEl || !dialog || !panel || !messagesEl || !composer || !composerInput || !statusEl) return null

  const endpoint = window.__CHAT_API_URL__ || CHAT_DEFAULT_PATH
  const exposeModelInfo = window.__CHAT_DEBUG_MODEL__ === true
  const state = {
    history: [],
    pending: false,
    lastFocus: null,
    sessionId: getOrCreateSessionId(),
    agentNodeApi: null
  }
  const launcherState = {
    section: 'home'
  }
  let lifecycleResetTimer = null
  let intentPillEl = null
  let panelAnim = {
    token: 0,
    raf: null,
    timeout: null,
    endHandler: null
  }

  const isOpen = () => !dialog.hidden

  const prefersReducedMotion = () => (
    typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )

  const resolveLauncherSource = () => {
    const slot = state.agentNodeApi?.getSlot?.() || agentNode.dataset.slot || 'hero'
    return slot === 'navbar' ? 'header' : 'hero'
  }

  const syncAgentLauncherChrome = (_section = 'home') => {
    const nextSection = normalizeSection(_section)
    const source = resolveLauncherSource()
    if (source === 'header') {
      agentInput.setAttribute('data-track', 'header_chat_input_focus')
      if (agentSend) agentSend.setAttribute('data-track', 'header_chat_submit')
    } else {
      agentInput.setAttribute('data-track', 'hero_chat_input_focus')
      if (agentSend) agentSend.setAttribute('data-track', 'hero_chat_submit')
    }
  }

  const clearPanelAnimation = () => {
    if (panelAnim.raf) {
      cancelAnimationFrame(panelAnim.raf)
      panelAnim.raf = null
    }
    if (panelAnim.timeout) {
      clearTimeout(panelAnim.timeout)
      panelAnim.timeout = null
    }
    if (panelAnim.endHandler) {
      panel.removeEventListener('transitionend', panelAnim.endHandler)
      panelAnim.endHandler = null
    }
    panel.style.removeProperty('transform')
    panel.style.removeProperty('transform-origin')
    panel.style.removeProperty('transition')
  }

  const readSeedRect = () => {
    const rect = state.agentNodeApi?.getRect?.() || agentNode.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return rect
  }

  const buildTransformFromSeed = (seedRect, targetRect) => {
    if (!seedRect || !targetRect || targetRect.width <= 0 || targetRect.height <= 0) return 'none'
    const dx = seedRect.left - targetRect.left
    const dy = seedRect.top - targetRect.top
    const sx = Math.max(0.08, seedRect.width / targetRect.width)
    const sy = Math.max(0.08, seedRect.height / targetRect.height)
    return `translate(${Math.round(dx)}px, ${Math.round(dy)}px) scale(${sx}, ${sy})`
  }

  syncChatLaunchersImpl = (section = 'home') => {
    const nextSection = normalizeSection(section)
    launcherState.section = nextSection
    syncAgentLauncherChrome(nextSection)
    state.agentNodeApi?.syncFromNavigation?.(nextSection)
    state.agentNodeApi?.syncTrailVisibility?.()
  }

  const clearIntentPill = () => {
    if (!intentPillEl) return
    intentPillEl.remove()
    intentPillEl = null
  }

  const setIntentPill = (rawText) => {
    clearIntentPill()
    const text = String(rawText || '').trim()
    if (!dialogHeader || !text) return
    const wrap = document.createElement('div')
    wrap.className = 'chat-dialog__intent-pill'

    const label = document.createElement('span')
    label.className = 'chat-dialog__intent-pill-text'
    label.textContent = text

    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'chat-dialog__intent-pill-dismiss'
    dismiss.setAttribute('aria-label', 'Dismiss topic hint')
    dismiss.textContent = '×'

    dismiss.addEventListener('click', () => {
      discardComposerDraft()
    })

    wrap.appendChild(label)
    wrap.appendChild(dismiss)
    dialogHeader.insertAdjacentElement('afterend', wrap)
    intentPillEl = wrap
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

    const target = messagesEl.closest('.chat-dialog__scroll') || messagesEl
    target.scrollTo({
      top: target.scrollHeight,
      behavior: prefersReduced ? 'auto' : 'smooth'
    })
  }

  const syncEmptyState = () => {
    const hasMessages = messagesEl.children.length > 0
    if (emptyStateEl) {
      emptyStateEl.hidden = hasMessages
      emptyStateEl.setAttribute('aria-hidden', hasMessages ? 'true' : 'false')
    }
    if (dialogSuggestions) {
      dialogSuggestions.hidden = hasMessages
      dialogSuggestions.setAttribute('aria-hidden', hasMessages ? 'true' : 'false')
    }
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
    syncEmptyState()
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

  const liveUi = { active: false, connecting: false }

  const reconcileComposerControls = () => {
    const textBusy = state.pending
    const voiceBusy = liveUi.active || liveUi.connecting
    composerInput.disabled = textBusy || voiceBusy
    if (composerSend) composerSend.disabled = textBusy || voiceBusy
    if (composerClear) composerClear.disabled = textBusy || voiceBusy
    if (composerMic) {
      const micBusy = (textBusy && !liveUi.active) || (liveUi.connecting && !liveUi.active)
      composerMic.disabled = micBusy
      composerMic.hidden = false
      composerMic.removeAttribute('inert')
    }
  }

  function discardComposerDraft({ focusComposer = true } = {}) {
    clearIntentPill()
    composerInput.value = ''
    autosizeComposer()
    reconcileComposerControls()
    if (focusComposer && isOpen() && typeof composerInput.focus === 'function') {
      composerInput.focus()
    }
  }

  const patchLiveUi = (patch) => {
    if ('active' in patch) liveUi.active = Boolean(patch.active)
    if ('connecting' in patch) liveUi.connecting = Boolean(patch.connecting)
    reconcileComposerControls()
  }

  const setComposerBusy = (busy) => {
    state.pending = busy
    reconcileComposerControls()
  }

  const setDialogVisible = (visible) => {
    dialog.hidden = !visible
    dialog.setAttribute('aria-hidden', visible ? 'false' : 'true')
    document.body.classList.toggle('chat-dialog-open', visible)
    state.agentNodeApi?.syncTrailVisibility?.()
  }

  const snapClose = ({ restoreFocus = true } = {}) => {
    clearPanelAnimation()
    clearIntentPill()
    setDialogVisible(false)
    state.agentNodeApi?.setState?.('bubble')
    agentInput.readOnly = launcherReadOnlyForDevice()
    agentInput.blur()
    setStatus('')
    if (restoreFocus && state.lastFocus && typeof state.lastFocus.focus === 'function') {
      state.lastFocus.focus()
    }
    state.lastFocus = null
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const n = document.getElementById('agentNode')
        if (n && (n.matches(':hover') || n.matches(':focus-within'))) {
          state.agentNodeApi?.setState?.('bar')
        }
      })
    })
  }

  const openPanel = () => {
    if (isOpen()) return
    clearIntentPill()
    state.lastFocus = document.activeElement
    clearPanelAnimation()
    state.agentNodeApi?.setState?.('modal')
    setDialogVisible(true)
    agentInput.readOnly = true
    agentInput.blur()

    const reduceMotion = prefersReducedMotion()
    const seedRect = readSeedRect()
    if (!reduceMotion && seedRect) {
      panel.style.transition = 'none'
      panel.style.transformOrigin = 'top left'
      const targetRect = panel.getBoundingClientRect()
      panel.style.transform = buildTransformFromSeed(seedRect, targetRect)
      panel.getBoundingClientRect()
      panelAnim.raf = requestAnimationFrame(() => {
        panelAnim.raf = null
        panel.style.transition = `transform ${PANEL_ANIM_MS}ms ${PANEL_ANIM_EASE}`
        panel.style.transform = 'none'
      })
    }

    requestAnimationFrame(() => {
      syncEmptyState()
      autosizeComposer()
      reconcileComposerControls()
      composerInput.focus()
    })
  }

  const closePanel = ({ restoreFocus = true, immediate = false } = {}) => {
    if (!isOpen()) return
    clearPanelAnimation()
    if (immediate || prefersReducedMotion()) {
      snapClose({ restoreFocus })
      return
    }

    const token = ++panelAnim.token
    const seedRect = readSeedRect()
    if (!seedRect) {
      snapClose({ restoreFocus })
      return
    }

    const fromRect = panel.getBoundingClientRect()
    const toTransform = buildTransformFromSeed(seedRect, fromRect)

    panel.style.transformOrigin = 'top left'
    panel.style.transition = `transform ${PANEL_ANIM_MS}ms ${PANEL_ANIM_EASE}`
    panel.style.transform = 'none'
    panel.getBoundingClientRect()

    const finish = () => {
      if (token !== panelAnim.token) return
      snapClose({ restoreFocus })
    }

    panelAnim.endHandler = (event) => {
      if (event.target !== panel || event.propertyName !== 'transform') return
      finish()
    }
    panel.addEventListener('transitionend', panelAnim.endHandler)
    panelAnim.timeout = setTimeout(finish, PANEL_ANIM_MS + 80)
    panel.style.transform = toTransform
  }

  collapseChat = () => closePanel({ restoreFocus: false, immediate: true })

  const openContactFromChat = (prefill) => {
    closePanel({ restoreFocus: false, immediate: true })
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
    clearIntentPill()
    messagesEl.textContent = ''
    syncEmptyState()
    state.history = []
    state.sessionId = renewSessionId()
    setStatus('Started over with a fresh chat session.')
    composerInput.value = ''
    autosizeComposer()
    if (focusTarget === 'hero') {
      agentInput.focus()
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
    const model = exposeModelInfo && typeof body?.model === 'string'
      ? body.model
      : ''
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

    if (source === 'composer') {
      clearIntentPill()
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
      setStatus('')
      scheduleIdleLifecycle(SUCCESS_IDLE_DELAY_MS, { source, model })
    } catch (error) {
      pendingAssistant.remove()
      setStatus(extractErrorMessage(error), 'error')
      chatBus.emit('error', { source, message: extractErrorMessage(error) })
      scheduleIdleLifecycle(ERROR_IDLE_DELAY_MS, { source })
    } finally {
      setComposerBusy(false)
      if (source === 'composer') {
        composerInput.focus()
      }
    }
  }

  const openPanelWithMessage = (text, source = 'hero', options = {}) => {
    const intentPill = typeof options.intentPill === 'string'
      ? options.intentPill.trim()
      : (typeof options.suggestedPromptPill === 'string' ? options.suggestedPromptPill.trim() : '')
    openPanel()
    if (intentPill) setIntentPill(intentPill)
    else clearIntentPill()
    void sendMessage(text, source)
  }

  const openPanelWithDraft = (text, _source = 'hero', options = {}) => {
    const body = String(text || '').trim()
    if (!body) return
    const intentPill = typeof options.intentPill === 'string'
      ? options.intentPill.trim()
      : (typeof options.suggestedPromptPill === 'string' ? options.suggestedPromptPill.trim() : '')
    openPanel()
    composerInput.value = body
    autosizeComposer()
    if (intentPill) setIntentPill(intentPill)
    else clearIntentPill()
    reconcileComposerControls()
    requestAnimationFrame(() => {
      if (!isOpen()) return
      composerInput.focus()
    })
  }

  agentInput.addEventListener('focus', () => {
    const source = resolveLauncherSource()
    if (source === 'header') {
      trackEvent('header_chat_focus', { surface: 'header' })
      return
    }
    trackEvent('hero_chat_focus', { surface: 'hero' })
  })

  agentInput.addEventListener('click', () => {
    if (state.history.length > 0 && !isOpen()) {
      openPanel()
    }
  })

  document.addEventListener('click', (event) => {
    const chipsRoot = event.target.closest('#heroChatSuggestions')
      || event.target.closest('#navbarChatSuggestions')
    if (!chipsRoot) return
    const chip = event.target.closest('[data-prompt]')
    if (!chip) return
    const prompt = String(chip.getAttribute('data-prompt') || '').trim()
    if (!prompt) return
    const source = resolveLauncherSource()
    if (source === 'header') {
      trackEvent('header_chat_chip', { prompt: chip.textContent || '' })
    } else {
      trackEvent('hero_chat_chip', { prompt: chip.textContent || '' })
    }
    openPanelWithDraft(prompt, source, { intentPill: prompt })
  })

  dialogSuggestions?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-prompt]')
    if (!chip) return
    const prompt = String(chip.getAttribute('data-prompt') || '').trim()
    if (!prompt) return
    trackEvent('chat_dialog_chip', { prompt: chip.textContent || '' })
    if (!isOpen()) openPanel()
    void sendMessage(prompt, 'composer')
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

  composerClear?.addEventListener('click', () => {
    discardComposerDraft()
  })

  backdrop?.addEventListener('click', () => closePanel())
  closeBtn?.addEventListener('click', () => closePanel())

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return
    event.preventDefault()
    const hasActiveTransition = Boolean(panelAnim.timeout || panelAnim.endHandler)
    closePanel({ immediate: hasActiveTransition })
  })

  window.addEventListener(EV_COLLAPSE, () => {
    closePanel({ restoreFocus: false, immediate: true })
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
  syncEmptyState()
  agentInput.readOnly = launcherReadOnlyForDevice()
  syncChatLaunchersImpl('home')
  chatBus.emit('idle', { source: 'chat-init' })

  const onOpenChatEvent = () => {
    openPanel()
    reconcileComposerControls()
  }
  window.addEventListener(EV_OPEN_CHAT, onOpenChatEvent)

  const disposeChatLiveVoice = bindChatLiveVoice({
    micButton: composerMic,
    messagesEl,
    statusEl,
    syncEmptyState,
    scrollMessagesToBottom,
    setStatus,
    getSessionId: () => state.sessionId,
    isTextPending: () => state.pending,
    openPanel,
    isPanelOpen: isOpen,
    patchLiveUi
  })

  reconcileComposerControls()

  const bindAgentNode = (agentNodeApi) => {
    state.agentNodeApi = agentNodeApi || null
    syncChatLaunchersImpl(launcherState.section || 'home')
  }

  return {
    bindAgentNode,
    disposeChatLiveVoice,
    openPanel: () => openPanel(),
    openPanelWithMessage: (text, source = resolveLauncherSource(), options) => openPanelWithMessage(text, source, options),
    openPanelWithDraft: (text, source = resolveLauncherSource(), options) => openPanelWithDraft(text, source, options),
    closePanelImmediate: ({ restoreFocus = false } = {}) => closePanel({ restoreFocus, immediate: true }),
    isOpen
  }
}
