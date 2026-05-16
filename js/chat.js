import { trackEvent } from './analytics.js'
import { openContactDialog } from './contact.js'
import { chatBus } from './chat-bus.js'
import { chatApiUrl } from './site-config.js'
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
  home: 'Pick a suggestion below, or type your question. Ask about my services, projects, and what I do.',
  portfolio: 'Pick a suggestion below, or type your question. Ask about my roles, what I shipped, how I work.',
  playground: 'Pick a suggestion below, or type your question. Ask about my experiments and what I can build.'
}

const CHAT_VOICE_EMPTY_HINT_BY_SECTION = {
  home: 'Start live chat to ask about my services, projects, and what I do — or type below and pick a suggestion.',
  portfolio: 'Start live chat to ask about my roles, what I shipped, and how I work — or type below and pick a suggestion.',
  playground: 'Start live chat to ask about my experiments and what I can build — or type below and pick a suggestion.'
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
  const emptyEntryEl = document.getElementById('chatEmptyEntry')
  const emptyStateEl = document.getElementById('chatEmptyState')
  const voiceStartHeaderSlot = document.getElementById('chatVoiceStartHeaderSlot')
  const voiceStartEntrySlot = document.getElementById('chatVoiceStartEntrySlot')
  const dockEl = document.getElementById('chatDialogDock')
  const voicePaneEl = document.getElementById('chatVoicePane')
  const voiceStartBtn = document.getElementById('chatVoiceStartBtn')
  const voiceLiveEl = document.getElementById('chatVoiceLive')
  const voicePaneMicBtn = document.getElementById('chatVoiceMic')
  const voicePaneStatusEl = document.getElementById('chatVoicePaneStatus')
  const dialogSuggestions = document.getElementById('chatDialogSuggestions')
  const composer = document.getElementById('chatComposer')
  const composerInput = document.getElementById('chatComposerInput')
  const composerSend = composer?.querySelector('.chat-composer__send')
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
    if (source === 'header') {
      if (agentNodeMic) agentNodeMic.setAttribute('data-track', 'header_agent_node_mic')
    } else {
      if (agentNodeMic) agentNodeMic.setAttribute('data-track', 'hero_agent_node_mic')
    }
    if (voiceStartBtn) voiceStartBtn.setAttribute('data-track', 'chat_voice_start')
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

  const liveUi = { active: false, connecting: false }
  let dockMode = 'text'
  let voiceAwaitingStart = false
  let voiceStartRequested = false
  const getEffectiveDockMode = () => {
    if (liveUi.active || liveUi.connecting) return 'voice'
    // Pre-start / empty: same text dock (chips + composer) whether opened from bar or mic.
    if (voiceAwaitingStart || voiceStartRequested) return 'text'
    if (!messagesEl.children.length) return 'text'
    return dockMode === 'text' ? 'text' : 'voice'
  }

  const syncDockMode = () => {
    const mode = getEffectiveDockMode()
    if (dockEl) dockEl.dataset.dockMode = mode
    if (panel) panel.dataset.dockMode = mode
  }

  const focusDockTarget = (target) => {
    if (target === 'voice') voiceStartBtn?.focus()
    else composerInput?.focus()
  }

  const clearVoiceAwaitingStart = () => {
    voiceAwaitingStart = false
    voiceStartRequested = false
    if (voiceStartBtn) voiceStartBtn.disabled = false
    reconcileVoicePane()
  }

  const setDockMode = (mode, { awaitingVoice = false, focus = null } = {}) => {
    if (awaitingVoice && !liveUi.active && !liveUi.connecting) {
      voiceAwaitingStart = true
      dockMode = 'text'
    } else {
      dockMode = mode === 'text' ? 'text' : 'voice'
      if (dockMode === 'text' && !liveUi.active && !liveUi.connecting) {
        voiceAwaitingStart = false
        voiceStartRequested = false
      }
    }
    syncDockMode()
    reconcileVoicePane()
    syncEmptyState()
    if (focus) requestAnimationFrame(() => focusDockTarget(focus))
  }

  const openPanelAwaitingVoiceStart = () => {
    openPanel({ mode: 'voice' })
  }

  const isVoiceAwaitingStartUi = () => Boolean(
    (voiceAwaitingStart || voiceStartRequested)
    && !liveUi.active
    && !liveUi.connecting
  )

  const isVoiceSessionUi = () => Boolean(
    liveUi.active || liveUi.connecting || liveUi.sessionOpen
  )

  const syncVoiceStartCta = () => {
    if (!voiceStartBtn) return

    const hasMessages = messagesEl.children.length > 0
    const showLive = Boolean(liveUi.active)
    const isHotSession = Boolean(liveUi.active || liveUi.sessionOpen)
    // "Connecting" = a mint/WS handshake is in flight but the session isn't
    // hot yet. We need to KEEP the button visible (disabled, "Connecting…"
    // label) in this window — otherwise the visitor sees the CTA vanish the
    // moment they click and gets no feedback during the 0.5-2s mint.
    const showConnecting = Boolean(
      (liveUi.connecting || voiceStartRequested)
      && !isHotSession
    )

    // Once the session is hot (setupComplete arrived), hide the start CTA —
    // the End button in the live pane takes over.
    if (isHotSession) {
      voiceStartBtn.hidden = true
      if (voiceStartHeaderSlot) {
        voiceStartHeaderSlot.hidden = true
        voiceStartHeaderSlot.setAttribute('aria-hidden', 'true')
      }
      return
    }

    // Position: entry slot when the conversation is empty (big CTA), header
    // slot once there's any transcript (compact CTA next to close button).
    const useHeader = hasMessages
    const slot = useHeader ? voiceStartHeaderSlot : voiceStartEntrySlot
    if (slot && voiceStartBtn.parentElement !== slot) slot.appendChild(voiceStartBtn)

    if (voiceStartHeaderSlot) {
      voiceStartHeaderSlot.hidden = !useHeader
      voiceStartHeaderSlot.setAttribute('aria-hidden', useHeader ? 'false' : 'true')
    }

    const mode = showConnecting ? 'connecting' : 'start'
    voiceStartBtn.hidden = false
    voiceStartBtn.removeAttribute('inert')
    voiceStartBtn.removeAttribute('aria-hidden')
    voiceStartBtn.dataset.voiceCtaMode = mode
    voiceStartBtn.classList.toggle('chat-voice-start-cta--header', useHeader)
    voiceStartBtn.classList.toggle('chat-voice-start-cta--connecting', showConnecting)
    voiceStartBtn.disabled = showConnecting
    voiceStartBtn.setAttribute('aria-pressed', showConnecting ? 'true' : 'false')
    voiceStartBtn.setAttribute('aria-busy', showConnecting ? 'true' : 'false')

    const label = voiceStartBtn.querySelector('.chat-voice-start-cta__label')
    if (label) {
      label.textContent = showConnecting ? 'Connecting…' : 'Start live chat'
    }
    voiceStartBtn.setAttribute(
      'aria-label',
      showConnecting ? 'Connecting voice…' : 'Start live chat',
    )
    voiceStartBtn.setAttribute('data-track', 'chat_voice_start')
  }

  const syncEmptyState = () => {
    const hasMessages = messagesEl.children.length > 0
    const showTypePeek = isVoiceAwaitingStartUi()
    const inVoiceSession = isVoiceSessionUi()
    const showEntry = !hasMessages && !inVoiceSession
    const sec = normalizeSection(launcherState.section)

    if (composerInput) {
      composerInput.placeholder = hasMessages
        ? 'Ask a follow-up…'
        : 'Ask a question…'
    }

    if (emptyEntryEl) {
      emptyEntryEl.hidden = !showEntry
      emptyEntryEl.setAttribute('aria-hidden', showEntry ? 'false' : 'true')
    }
    if (emptyStateEl && showEntry) {
      emptyStateEl.textContent = showTypePeek
        ? (CHAT_VOICE_EMPTY_HINT_BY_SECTION[sec] || CHAT_VOICE_EMPTY_HINT_BY_SECTION.home)
        : (CHAT_EMPTY_HINT_BY_SECTION[sec] || CHAT_EMPTY_HINT_BY_SECTION.home)
    }
    syncVoiceStartCta()
    if (dialogSuggestions) {
      const showChips = showEntry
      dialogSuggestions.hidden = !showChips
      dialogSuggestions.setAttribute('aria-hidden', showChips ? 'false' : 'true')
      if (showChips && state.agentNodeApi?.getPlaceholderSuggestion) {
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
    const voiceBusy = liveUi.active || liveUi.connecting
    const showTypePeek = isVoiceAwaitingStartUi()
    composerInput.disabled = textBusy || (voiceBusy && !showTypePeek)
    if (composerSend) composerSend.disabled = textBusy || (voiceBusy && !showTypePeek)
    if (voiceStartBtn || agentNodeMic) {
      prepareVoiceLauncherButtons(agentNodeMic)
      const micBusy = (textBusy && !liveUi.active) || (liveUi.connecting && !liveUi.active)
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
    if ('sessionOpen' in patch) liveUi.sessionOpen = Boolean(patch.sessionOpen)
    if (liveUi.active || liveUi.sessionOpen) {
      voiceAwaitingStart = false
      voiceStartRequested = false
    } else if (
      voiceStartRequested
      && !liveUi.connecting
      && !liveUi.active
      && !liveUi.sessionOpen
    ) {
      voiceAwaitingStart = true
      voiceStartRequested = false
    }
    reconcileComposerControls()
    reconcileVoicePane()
  }

  /** Phase 3b: while voice is active the pane replaces the composer + chip row.
   *  Status text follows the voice state (greeting / listening / speaking is
   *  hinted by the aura — copy stays simple to avoid distracting flicker). */
  const reconcileVoicePane = () => {
    const showLive = Boolean(liveUi.active)
    const showConnecting = Boolean(liveUi.connecting)
    const showVoiceUi = isVoiceSessionUi()

    const showStartGate = Boolean(
      (voiceAwaitingStart || voiceStartRequested || showConnecting)
      && !showLive
    )

    syncDockMode()

    if (dockEl) {
      dockEl.classList.toggle('chat-dialog__dock--live', showLive)
      dockEl.hidden = false
      dockEl.setAttribute('aria-hidden', 'false')
    }

    if (voiceLiveEl) {
      voiceLiveEl.hidden = !showLive
      voiceLiveEl.setAttribute('aria-hidden', showLive ? 'false' : 'true')
    }

    if (panel) {
      panel.toggleAttribute('data-voice-active', showVoiceUi)
    }

    if (voicePaneStatusEl) {
      voicePaneStatusEl.textContent = showLive
        ? "Listening — speak about Marwan's work."
        : 'Listening…'
    }
    if (!showLive) {
      voicePaneEl.style.removeProperty('--gvp-voice-input-level')
      voicePaneEl.style.removeProperty('--gvp-voice-output-level')
    }
    syncEmptyState()
    if (showLive) scrollMessagesToBottom(true)
  }

  // rAF-coalesce live audio levels into CSS vars on the pane. Audio frames
  // arrive every ~30ms; we throttle DOM writes to display rate. Smoothing
  // (max of recent vs. new × decay) keeps the halo from flashing on attack.
  let levelState = { input: 0, output: 0 }
  let levelFrame = 0
  let pendingLevelWrite = false
  const flushLevels = () => {
    pendingLevelWrite = false
    if (!voicePaneEl) return
    voicePaneEl.style.setProperty('--gvp-voice-input-level', levelState.input.toFixed(3))
    voicePaneEl.style.setProperty('--gvp-voice-output-level', levelState.output.toFixed(3))
  }
  const scheduleLevelWrite = () => {
    if (pendingLevelWrite) return
    pendingLevelWrite = true
    levelFrame = requestAnimationFrame(flushLevels)
  }
  const SMOOTH_DECAY = 0.82  // higher = slower fall-off; tuned so the halo
                              // breathes with cadence instead of strobing.
  const handleAudioLevels = ({ source, level }) => {
    // Normalize RMS roughly into [0,1] — speech sits around 0.05-0.20 RMS, so
    // multiply to push the halo into a visible range without hard-clipping.
    const visual = Math.min(1, Math.max(0, level * 5.5))
    if (source === 'input') {
      levelState.input = Math.max(visual, levelState.input * SMOOTH_DECAY)
    } else if (source === 'output') {
      levelState.output = Math.max(visual, levelState.output * SMOOTH_DECAY)
    }
    scheduleLevelWrite()
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
    // Phase 5: closing the dialog mid-voice would otherwise leave the live
    // session running invisibly (no UI, but billing / audio output keeps
    // going). Silent stop — no extra error chip; user explicitly closed.
    // Also catches the connecting window — without this, X-ing the dialog
    // while the WS handshake is still in flight let the session establish
    // server-side and idle until the no-mic timer fired.
    if (
      liveVoice?.isSessionOpen?.()
      || liveUi.connecting
      || liveUi.active
      || voiceStartRequested
    ) {
      liveVoice?.stopVoice?.({ silent: true })
    }
    clearVoiceAwaitingStart()
    dockMode = 'voice'
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

  const openPanel = ({ mode = 'text' } = {}) => {
    const wantVoice = mode === 'voice'
    if (isOpen()) {
      setDockMode(wantVoice ? 'voice' : 'text', {
        awaitingVoice: wantVoice,
        focus: wantVoice ? 'voice' : 'text'
      })
      return
    }
    if (wantVoice) {
      dockMode = 'text'
      voiceAwaitingStart = true
    } else {
      dockMode = 'text'
      clearVoiceAwaitingStart()
    }
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
      reconcileVoicePane()
      if (wantVoice) voiceStartBtn?.focus()
      else composerInput.focus()
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
    clearVoiceAwaitingStart()
    if (liveVoice && typeof liveVoice.stopVoice === 'function' && liveVoice.isSessionOpen?.()) {
      liveVoice.stopVoice({ silent: true })
    }
    // Re-arm the greeting so the next voice session in this fresh conversation
    // says hello again (Phase 5).
    liveVoice?.resetGreet?.()
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
    if (voiceAwaitingStart || voiceStartRequested) clearVoiceAwaitingStart()
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

  composerInput.addEventListener('focus', () => {
    if (isVoiceAwaitingStartUi()) return
    if (getEffectiveDockMode() !== 'text') setDockMode('text')
  })

  composerInput.addEventListener('input', () => {
    autosizeComposer()
    if (isVoiceAwaitingStartUi()) {
      if (composerInput.value.trim().length > 0) {
        clearVoiceAwaitingStart()
        setDockMode('text')
      }
      return
    }
    if (getEffectiveDockMode() !== 'text') setDockMode('text')
    if (composerInput.value.length > 0 && liveVoice && typeof liveVoice.stopVoice === 'function' && liveVoice.isSessionOpen?.()) {
      liveVoice.stopVoice({ silent: true })
    }
  })

  // Hero voice CTA (below text bar). Opens dialog in voice intent.
  const heroVoiceBtn = document.getElementById('heroVoiceMic')
  if (heroVoiceBtn) {
    heroVoiceBtn.addEventListener('click', () => {
      trackEvent('hero_voice_mic', {})
      if (!liveVoice || typeof liveVoice.startVoice !== 'function') {
        // Live binding refused (e.g. mic permission denied at construct time) —
        // open the dialog in text mode so the visitor can still ask their
        // question instead of getting a dead button.
        openPanel()
        return
      }
      openPanelAwaitingVoiceStart()
    })
  }
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
    const switchEl = event.target.closest('[data-dock-switch]')
    if (switchEl && dialog.contains(switchEl)) {
      const target = switchEl.dataset.dockSwitch
      if (target === 'text') {
        trackEvent('chat_dock_switch_text', {})
        setDockMode('text', { focus: 'text' })
        return
      }
      if (target === 'voice') {
        trackEvent('chat_dock_switch_voice', {})
        setDockMode('voice', { awaitingVoice: true, focus: 'voice' })
        return
      }
    }
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
    openPanel({ mode: 'text' })
    reconcileComposerControls()
  }
  window.addEventListener(EV_OPEN_CHAT, onOpenChatEvent)

  // Dispatch tool calls emitted by the Live API in voice mode. Mirrors the
  // text-chat action handler below: same destinations, no buttons (voice executes
  // immediately). Return value is sent back as toolResponse.response so the model
  // knows the action ran.
  const applyVoiceToolCall = (name, args) => {
    if (name === 'open_resume') {
      window.open(RESUME_URL, '_blank', 'noopener,noreferrer')
      return { result: 'opened_resume' }
    }
    if (name === 'open_contact_form') {
      const prefill = args && typeof args === 'object'
        ? { subject: typeof args.subject === 'string' ? args.subject : '',
            message: typeof args.message === 'string' ? args.message : '' }
        : null
      openContactFromChat(prefill)
      return { result: 'opened_contact_form' }
    }
    if (name === 'navigate_to_section') {
      const section = args && typeof args.section === 'string' ? args.section : ''
      if (section === 'home') {
        history.replaceState(null, '', './')
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      } else if (section === 'portfolio' || section === 'playground') {
        window.location.hash = `#${section}`
      } else {
        return { error: `unknown_section: ${section}` }
      }
      return { result: 'navigated', section }
    }
    return { error: `unknown_tool: ${name}` }
  }

  const scrollTranscript = (force = false) => {
    scrollMessagesToBottom(force || liveUi.active)
  }

  const liveVoice = bindChatLiveVoice({
    micButtons: [agentNodeMic, voicePaneMicBtn].filter(Boolean),
    messagesEl,
    statusEl,
    syncEmptyState,
    scrollMessagesToBottom: scrollTranscript,
    setStatus,
    getSessionId: () => state.sessionId,
    isTextPending: () => state.pending,
    openPanel,
    isPanelOpen: isOpen,
    patchLiveUi,
    onToolCall: applyVoiceToolCall,
    onAudioLevels: handleAudioLevels,
    onVoiceLauncherRequest: () => {
      if (liveUi.active || liveUi.connecting) return false
      if (liveVoice?.isSessionOpen?.()) return false
      if (!isOpen()) openPanel({ mode: 'voice' })
      else setDockMode('voice', { awaitingVoice: true, focus: 'voice' })
      return true
    },
  }) || {}

  if (voiceStartBtn) {
    voiceStartBtn.addEventListener('click', () => {
      if (!liveVoice || typeof liveVoice.startVoice !== 'function') {
        setStatus('Voice is not available right now.', 'error')
        return
      }
      // Guards: don't re-fire when voice is already up or in flight. Without
      // these the button could mint a second token while the first is still
      // connecting (server drops it via voiceConnectInFlight in chat-live, but
      // the user sees a clickable button → confusing). Disable the button
      // synchronously so a second click never reaches us.
      if (
        voiceStartRequested
        || liveUi.connecting
        || liveUi.active
        || liveUi.sessionOpen
        || liveVoice.isActive?.()
        || liveVoice.isSessionOpen?.()
      ) {
        return
      }
      trackEvent('chat_voice_start', {})
      voiceStartRequested = true
      voiceAwaitingStart = false
      voiceStartBtn.disabled = true
      reconcileVoicePane()
      void liveVoice.startVoice({ intent: 'auto' })
    })
  }

  // Compat: old call sites expected a dispose function. Keep that shape too.
  const disposeChatLiveVoice = typeof liveVoice === 'function'
    ? liveVoice
    : (liveVoice.dispose || (() => {}))

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
    liveVoice,
    openPanel: () => openPanel(),
    openPanelWithMessage: (text, source = resolveLauncherSource(), options) => openPanelWithMessage(text, source, options),
    openPanelWithDraft: (text, source = resolveLauncherSource(), options) => openPanelWithDraft(text, source, options),
    /** Open dialog with voice intent: starts the live session immediately so
     *  the greeting plays as the dialog mounts. Phase 2's chooser big-mic and
     *  Phase 4's hero mic both come through here. */
    openPanelForVoice: () => {
      openPanelAwaitingVoiceStart()
    },
    openPanelAwaitingVoiceStart,
    clearVoiceAwaitingStart,
    closePanelImmediate: ({ restoreFocus = false } = {}) => closePanel({ restoreFocus, immediate: true }),
    isOpen
  }
}
