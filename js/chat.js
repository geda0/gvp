import { trackEvent } from './analytics.js'
import { openContactDialog } from './contact.js'
import { chatBus } from './chat-bus.js'
import { chatApiUrl, chatVoiceFeatureEnabled } from './site-config.js'
import { normalizeSection } from './section-names.js'
import { bindChatLiveVoice } from './chat-live.js'
import { PANEL_ANIM_MS, PANEL_ANIM_EASE } from './chat-panel-anim.js'

const CHAT_DEFAULT_PATH = '/api/chat'
const RESUME_URL = 'resume/Marwan_Elgendy_Resume_public.pdf'

/** Preset prompts per route — Home = capability pitch; Portfolio / Playground = page-native depth. */
const SECTION_PROMPT_CHIPS = {
  home: {
    hero: [
      {
        prompt: 'What can you do?',
        label: 'What can you do?',
        track: 'hero_chat_chip_what_can_you_do'
      },
      {
        prompt: 'What are your services?',
        label: 'What are your services?',
        track: 'hero_chat_chip_services'
      },
      {
        prompt: 'How do you build production AI?',
        label: 'Production AI?',
        track: 'hero_chat_chip_production_ai'
      }
    ],
    dialog: [
      {
        prompt: 'What data engineering work do you take on?',
        label: 'Data engineering?',
        track: 'chat_dialog_chip_data'
      },
      {
        prompt: 'What migrations have you led?',
        label: 'Migrations?',
        track: 'chat_dialog_chip_migrations'
      },
      {
        prompt: 'How do you engage — review, build, or lead?',
        label: 'How do you engage?',
        track: 'chat_dialog_chip_engagement'
      }
    ]
  },
  portfolio: {
    hero: [
      {
        prompt: 'Show me architecture you have shipped.',
        label: 'Architecture you have shipped?',
        track: 'hero_chat_chip_architecture_proof'
      },
      {
        prompt: 'Tell me about your work at Apptio (IBM).',
        label: 'Apptio (IBM)?',
        track: 'hero_chat_chip_apptio'
      },
      {
        prompt: 'Which project should I look at first?',
        label: 'Where to start?',
        track: 'hero_chat_chip_start_here'
      }
    ],
    dialog: [
      {
        prompt: 'How did you scale Instant Ink from thousands to millions?',
        label: 'Scaling Instant Ink?',
        track: 'chat_dialog_chip_scaling'
      },
      {
        prompt: 'How did the hybrid Postgres/Mongo + GraphQL design work at JumpCloud?',
        label: 'JumpCloud data layer?',
        track: 'chat_dialog_chip_jumpcloud'
      },
      {
        prompt: 'Walk me through a migration you have led.',
        label: 'A migration you have led?',
        track: 'chat_dialog_chip_migration_proof'
      }
    ]
  },
  playground: {
    hero: [
      {
        prompt: 'Show me what you can build.',
        label: 'What can you build?',
        track: 'hero_chat_chip_what_can_you_build'
      },
      {
        prompt: 'How would you build production AI?',
        label: 'How would you build AI?',
        track: 'hero_chat_chip_production_ai_pg'
      },
      {
        prompt: 'Show me your hardware and vision work.',
        label: 'Hardware + vision?',
        track: 'hero_chat_chip_hardware'
      }
    ],
    dialog: [
      {
        prompt: 'How do you take experiments to production?',
        label: 'Experiment to production?',
        track: 'chat_dialog_chip_experiment_to_product'
      },
      {
        prompt: 'Tell me about the Generative Video Platform.',
        label: 'Generative Video Platform?',
        track: 'chat_dialog_chip_gvp'
      },
      {
        prompt: 'How do you build under tight constraints?',
        label: 'Tight constraints?',
        track: 'chat_dialog_chip_constraints'
      }
    ]
  }
}

/** Empty transcript copy — chips + rotating placeholders follow the active section (Home / Portfolio / Playground). */
const CHAT_EMPTY_HINT_BY_SECTION = {
  home: 'Home prompts: my services, where I fit, and how I work.',
  portfolio: 'Portfolio prompts: my shipped work as proof.',
  playground: 'Playground prompts: experiments and what I can build.'
}

function replaceSectionPresetChips(container, chips, chipClassName) {
  if (!container || !Array.isArray(chips)) return
  const removeSelector = chipClassName === 'chat-dialog__chip'
    ? 'button.chat-dialog__chip:not([data-gvp-dialog-placeholder])'
    : 'button.hero-chat__chip'
  container.querySelectorAll(removeSelector).forEach((n) => n.remove())
  chips.forEach((c) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = chipClassName
    btn.setAttribute('data-prompt', c.prompt)
    btn.setAttribute('data-chip-label', c.label)
    if (c.track) btn.setAttribute('data-track', c.track)
    btn.textContent = c.label
    container.appendChild(btn)
  })
}

const EV_COLLAPSE = 'gvp:site-chat-collapse'
/** Open chat dialog from decoupled surfaces (e.g. spaceman) without importing chat from those modules. */
export const EV_OPEN_CHAT = 'gvp:open-chat'
const SESSION_KEY = 'gvp-chat-session-id'
const MAX_COMPOSER_HEIGHT = 128
const SUCCESS_IDLE_DELAY_MS = 700
const ERROR_IDLE_DELAY_MS = 2300
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'

function readChipLabel(el) {
  const explicit = typeof el?.getAttribute === 'function'
    ? el.getAttribute('data-chip-label')?.trim()
    : ''
  if (explicit) return explicit
  return String(el?.textContent || '').trim()
}

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
  const agentNodeMic = document.getElementById('agentNodeMic')
  const agentNodeSubmit = document.getElementById('agentNodeSubmit')
  const heroSlotEl = document.getElementById('agentSlotHero')

  const dialog = document.getElementById('chatDialog')
  const panel = dialog?.querySelector('.chat-dialog__panel')
  const backdrop = dialog?.querySelector('.chat-dialog__backdrop')
  const closeBtn = dialog?.querySelector('.chat-dialog__close')
  const messagesEl = document.getElementById('chatMessages')
  const emptyStateEl = document.getElementById('chatEmptyState')
  const dialogSuggestions = document.getElementById('chatDialogSuggestions')
  const composer = document.getElementById('chatComposer')
  const composerInput = document.getElementById('chatComposerInput')
  const composerSend = composer?.querySelector('.chat-composer__send')
  const composerMic = document.getElementById('chatComposerMic')
  const statusEl = document.getElementById('chatStatus')

  if (!agentNode || !agentForm || !agentInput || !heroSlotEl || !dialog || !panel || !messagesEl || !composer || !composerInput || !statusEl) return null

  const PLACEHOLDER_DIALOG_CHIP_ATTR = 'data-gvp-dialog-placeholder'
  const PLACEHOLDER_HIGHLIGHT_MS = 2800
  let placeholderHighlightTimer = null

  const clearPlaceholderHighlightTimer = () => {
    if (placeholderHighlightTimer == null) return
    clearTimeout(placeholderHighlightTimer)
    placeholderHighlightTimer = null
  }

  const flashPlaceholderSuggestionHighlight = () => {
    if (!dialogSuggestions || dialog.hidden) return
    const chip = dialogSuggestions.querySelector(`button[${PLACEHOLDER_DIALOG_CHIP_ATTR}]`)
    if (!chip) return
    clearPlaceholderHighlightTimer()
    chip.classList.remove('chat-dialog__chip--new-highlight')
    void chip.offsetWidth
    chip.classList.add('chat-dialog__chip--new-highlight')
    placeholderHighlightTimer = setTimeout(() => {
      chip.classList.remove('chat-dialog__chip--new-highlight')
      placeholderHighlightTimer = null
    }, PLACEHOLDER_HIGHLIGHT_MS)
  }

  const renderDialogPlaceholderChips = (detail) => {
    if (!dialogSuggestions) return
    if (messagesEl.children.length > 0) return
    const teaser = String(detail?.teaser || '').trim()
    const deep = String(detail?.deepQuestion || '').trim()
    dialogSuggestions.querySelector(`button[${PLACEHOLDER_DIALOG_CHIP_ATTR}]`)?.remove()
    if (!teaser || !deep) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chat-dialog__chip chat-dialog__chip--from-placeholder'
    btn.setAttribute(PLACEHOLDER_DIALOG_CHIP_ATTR, '1')
    btn.setAttribute('data-prompt', deep)
    btn.setAttribute('data-chip-label', teaser)
    btn.textContent = teaser
    btn.title = deep
    btn.setAttribute('data-track', 'chat_dialog_chip_placeholder')
    dialogSuggestions.appendChild(btn)
    flashPlaceholderSuggestionHighlight()
  }

  const endpoint = chatApiUrl || CHAT_DEFAULT_PATH
  const exposeModelInfo = window.__CHAT_DEBUG_MODEL__ === true
  const state = {
    history: [],
    pending: false,
    lastFocus: null,
    sessionId: getOrCreateSessionId(),
    agentNodeApi: null,
    placeholderUnsub: null
  }
  const launcherState = {
    section: 'home'
  }
  let lifecycleResetTimer = null
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
    normalizeSection(_section)
    const source = resolveLauncherSource()
    if (source === 'header') {
      agentInput.setAttribute('data-track', 'header_chat_input_focus')
    } else {
      agentInput.setAttribute('data-track', 'hero_chat_input_focus')
    }
    if (agentNodeSubmit) {
      if (source === 'header') {
        agentNodeSubmit.setAttribute('data-track', 'header_chat_submit')
      } else {
        agentNodeSubmit.setAttribute('data-track', 'hero_chat_submit')
      }
    }
    if (!chatVoiceFeatureEnabled) return
    if (source === 'header') {
      if (agentNodeMic) agentNodeMic.setAttribute('data-track', 'header_agent_node_mic')
    } else {
      if (agentNodeMic) agentNodeMic.setAttribute('data-track', 'hero_agent_node_mic')
    }
    if (composerMic) composerMic.setAttribute('data-track', 'chat_composer_mic')
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

  const heroSuggestionsEl = document.getElementById('heroChatSuggestions')

  const applySectionPromptChips = (section = 'home') => {
    const nextSection = normalizeSection(section)
    const pack = SECTION_PROMPT_CHIPS[nextSection] || SECTION_PROMPT_CHIPS.home
    replaceSectionPresetChips(heroSuggestionsEl, pack.hero, 'hero-chat__chip')
    replaceSectionPresetChips(dialogSuggestions, pack.dialog, 'chat-dialog__chip')
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

  const NEAR_BOTTOM_THRESHOLD_PX = 120
  let scrollCoalesceRaf = null

  const scrollMessagesToBottom = (force = false) => {
    const target = messagesEl.closest('.chat-dialog__scroll') || messagesEl
    // Only auto-smooth-scroll when the user is already near the bottom; if they
    // scrolled up to read history, leave them be. Coalesce rapid calls so long
    // transcripts (streaming/voice) do not jank with one scrollTo per fragment.
    // `force` is used for user-initiated sends, which should always land at the bottom.
    if (!force) {
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
      const nearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX
      if (!nearBottom) return
    }

    if (scrollCoalesceRaf) cancelAnimationFrame(scrollCoalesceRaf)
    scrollCoalesceRaf = requestAnimationFrame(() => {
      scrollCoalesceRaf = null
      const prefersReduced = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      // Smooth only for short lists; instant jump avoids jank on long transcripts.
      const longTranscript = messagesEl.children.length > 30
      target.scrollTo({
        top: target.scrollHeight,
        behavior: (prefersReduced || longTranscript) ? 'auto' : 'smooth'
      })
    })
  }

  const syncEmptyState = () => {
    const hasMessages = messagesEl.children.length > 0
    if (emptyStateEl) {
      emptyStateEl.hidden = hasMessages
      emptyStateEl.setAttribute('aria-hidden', hasMessages ? 'true' : 'false')
      if (!hasMessages) {
        const sec = normalizeSection(launcherState.section)
        emptyStateEl.textContent = CHAT_EMPTY_HINT_BY_SECTION[sec] || CHAT_EMPTY_HINT_BY_SECTION.home
      }
    }
    if (dialogSuggestions) {
      dialogSuggestions.hidden = hasMessages
      dialogSuggestions.setAttribute('aria-hidden', hasMessages ? 'true' : 'false')
      if (!hasMessages && state.agentNodeApi?.getPlaceholderSuggestion) {
        renderDialogPlaceholderChips(state.agentNodeApi.getPlaceholderSuggestion())
      }
    }
  }

  syncChatLaunchersImpl = (section = 'home') => {
    const nextSection = normalizeSection(section)
    launcherState.section = nextSection
    syncAgentLauncherChrome(nextSection)
    state.agentNodeApi?.syncFromNavigation?.(nextSection)
    applySectionPromptChips(nextSection)
    syncEmptyState()
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
    scrollMessagesToBottom(Boolean(options.forceScroll))
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

  const prepareVoiceLauncherButtons = (btn) => {
    if (!btn) return
    btn.setAttribute('data-gvp-launcher', 'voice')
    const voiceIcon = btn.querySelector('.chat-composer__launcher-icon--voice')
    const chatIcon = btn.querySelector('.chat-composer__launcher-icon--chat')
    if (voiceIcon) voiceIcon.hidden = false
    if (chatIcon) chatIcon.hidden = true
    btn.setAttribute('aria-label', 'Start voice mode')
  }

  const reconcileComposerControls = () => {
    const textBusy = state.pending
    const voiceBusy =
      chatVoiceFeatureEnabled && (liveUi.active || liveUi.connecting)
    composerInput.disabled = textBusy || voiceBusy
    if (composerSend) composerSend.disabled = textBusy || voiceBusy
    if (!chatVoiceFeatureEnabled) {
      if (composerMic) {
        composerMic.hidden = true
        composerMic.disabled = true
        composerMic.setAttribute('inert', '')
        composerMic.setAttribute('aria-hidden', 'true')
        composerMic.removeAttribute('aria-pressed')
        composerMic.removeAttribute('data-gvp-launcher')
      }
      if (agentNodeMic) {
        agentNodeMic.hidden = true
        agentNodeMic.disabled = true
        agentNodeMic.setAttribute('inert', '')
        agentNodeMic.setAttribute('aria-hidden', 'true')
        agentNodeMic.removeAttribute('aria-pressed')
        agentNodeMic.removeAttribute('data-gvp-launcher')
      }
      syncAgentLauncherChrome(launcherState.section)
      return
    }
    if (composerMic || agentNodeMic) {
      prepareVoiceLauncherButtons(composerMic)
      prepareVoiceLauncherButtons(agentNodeMic)
      const micBusy = (textBusy && !liveUi.active) || (liveUi.connecting && !liveUi.active)
      if (composerMic) {
        composerMic.disabled = micBusy
        composerMic.hidden = false
        composerMic.removeAttribute('inert')
        composerMic.removeAttribute('aria-hidden')
      }
      if (agentNodeMic) {
        agentNodeMic.disabled = micBusy
        agentNodeMic.removeAttribute('inert')
        agentNodeMic.removeAttribute('aria-hidden')
      }
      syncAgentLauncherChrome(launcherState.section)
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
  }

  const snapClose = ({ restoreFocus = true } = {}) => {
    clearPanelAnimation()
    clearPlaceholderHighlightTimer()
    dialogSuggestions?.querySelector(`button[${PLACEHOLDER_DIALOG_CHIP_ATTR}]`)
      ?.classList.remove('chat-dialog__chip--new-highlight')
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
    composerInput.value = ''
    autosizeComposer()
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
    openContactDialog()
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

  const CHAT_MAX_RETRIES = 2
  const CHAT_RETRY_BACKOFF_MS = [400, 900]

  // Marker error: thrown for transient failures (429 / network) so the retry
  // loop knows it may try again; the `.message` is already user-facing.
  const makeRetryableError = (message) => {
    const err = new Error(message)
    err.retryable = true
    return err
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const postChatOnce = async (history) => {
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          stream: false,
          sessionId: state.sessionId
        })
      })
    } catch (_) {
      // fetch() rejects on offline / DNS / connection reset — all transient.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw makeRetryableError('You appear to be offline. Check your connection and try again.')
      }
      throw makeRetryableError('Could not reach the chat service. Check your connection and try again.')
    }

    const contentType = response.headers.get('content-type') || ''
    const text = await response.text()
    const wantsJson = contentType.includes('application/json')
    const unexpectedReply = () => new Error(
      'The chat service returned an unexpected reply. Try again.'
    )
    let body = {}
    if (wantsJson && text.trim()) {
      try {
        body = JSON.parse(text)
      } catch (_) {
        body = null
      }
    }

    if (!response.ok) {
      if (body === null) {
        throw unexpectedReply()
      }
      const detail = body?.detail || body?.error
      if (response.status === 429) {
        throw makeRetryableError('Service is busy. Try again in a moment.')
      }
      if (response.status >= 500) {
        // Server errors are not retried here (could be a hard failure), but
        // surface them specifically rather than as a generic message.
        throw new Error('The chat service hit an error. Try again shortly.')
      }
      if (typeof detail === 'string' && detail.trim()) {
        throw new Error(detail.trim())
      }
      throw new Error('Chat request failed. Try again.')
    }

    if (body === null || typeof body !== 'object') {
      throw unexpectedReply()
    }
    if (!wantsJson && text.trim()) {
      throw unexpectedReply()
    }

    const reply = typeof body?.reply === 'string' ? body.reply : ''
    const model = exposeModelInfo && typeof body?.model === 'string'
      ? body.model
      : ''
    const actions = Array.isArray(body?.actions) ? body.actions : []
    return { reply, model, actions }
  }

  const postChat = async (history) => {
    let lastError = null
    for (let attempt = 0; attempt <= CHAT_MAX_RETRIES; attempt++) {
      try {
        return await postChatOnce(history)
      } catch (error) {
        lastError = error
        if (!error || !error.retryable || attempt === CHAT_MAX_RETRIES) {
          throw error
        }
        await sleep(CHAT_RETRY_BACKOFF_MS[attempt] || 900)
      }
    }
    throw lastError || new Error('Chat request failed. Try again.')
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
    appendMessage('user', text, { forceScroll: true })
    state.history = state.history.concat({ role: 'user', content: text })
    if (source === 'composer') {
      composerInput.value = ''
      autosizeComposer()
    }

    setComposerBusy(true)
    const pendingAssistant = appendMessage('assistant', '', { streaming: true, forceScroll: true })

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

  const openPanelWithMessage = (text, source = 'hero', _options = {}) => {
    openPanel()
    void sendMessage(text, source)
  }

  const openPanelWithDraft = (text, _source = 'hero', _options = {}) => {
    const body = String(text || '').trim()
    if (!body) return
    openPanel()
    composerInput.value = body
    autosizeComposer()
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
    if (!chipsRoot) return
    const chip = event.target.closest('[data-prompt]')
    if (!chip) return
    const prompt = String(chip.getAttribute('data-prompt') || '').trim()
    if (!prompt) return
    const source = resolveLauncherSource()
    const label = readChipLabel(chip) || prompt
    if (source === 'header') {
      trackEvent('header_chat_chip', { prompt: label })
    } else {
      trackEvent('hero_chat_chip', { prompt: label })
    }
    openPanelWithMessage(prompt, source)
  })

  dialogSuggestions?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-prompt]')
    if (!chip) return
    const prompt = String(chip.getAttribute('data-prompt') || '').trim()
    if (!prompt) return
    const label = readChipLabel(chip) || prompt
    trackEvent('chat_dialog_chip', { prompt: label })
    openPanelWithMessage(prompt, 'composer')
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
    micButtons: chatVoiceFeatureEnabled ? [composerMic, agentNodeMic].filter(Boolean) : [],
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
    state.placeholderUnsub?.()
    state.placeholderUnsub = null
    state.agentNodeApi = agentNodeApi || null
    if (agentNodeApi?.subscribePlaceholder) {
      state.placeholderUnsub = agentNodeApi.subscribePlaceholder((detail) => {
        renderDialogPlaceholderChips(detail)
      })
    }
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
