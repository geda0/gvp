import { trackEvent } from './analytics.js'
import { openContactDialog } from './contact.js'
import { chatBus } from './chat-bus.js'
import { chatApiUrl } from './site-config.js'
import { normalizeSection } from './section-names.js'
import { requestNavigation } from './navigation.js'
import { requestProjectOpen, requestProjectClose } from './projects.js'
import {
  subscribe as subscribeSiteState,
  getSiteState,
  getSiteStateForWire,
  siteStateWireIfNotable,
  setChatStage,
  setVoiceActive
} from './site-state.js'
import {
  nextChatStage,
  stageChrome,
  hasRoomBesideDialog,
  parseChatSize,
  dockedSizeChrome,
  dockedCardWidth,
  DOCK_GUTTER
} from './chat-stage.js'
import { projectChipPrompt } from './project-chips.js'
import { bindChatLiveVoice } from './chat-live.js'
import { PANEL_ANIM_MS, PANEL_ANIM_EASE } from './chat-panel-anim.js'
import { deriveReplyText } from './chat-reply-text.js'
import { hasNavPromiseGap } from './nav-promise-gap.js'
import { buildChatRequest } from './chat-payload-hash.js'
import { createChatPrewarm } from './chat-prewarm.js'
import { tourStep } from './tour.js'

const CHAT_DEFAULT_PATH = '/api/chat'
const RESUME_URL = 'resume/Marwan_Elgendy_Resume_public.pdf'

/** Avoid popping the on-screen keyboard when opening chat on touch devices. */
function shouldAutofocusChatInput() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

/** Ignore stray click synthesis on dialog chips right after open (mobile ghost tap). */
const DIALOG_CHIP_ACTIVATION_GUARD_MS = 500

/** Preset prompts per route — Home = capability pitch; Portfolio = page-native depth;
 *  Labs = personal builds / experiments. */
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
  labs: {
    hero: [
      {
        prompt: 'Tell me about Team Tactics.',
        label: 'Team Tactics?',
        track: 'hero_chat_chip_team_tactics'
      },
      {
        prompt: 'What can you build at the experiment scale?',
        label: 'What can you build?',
        track: 'hero_chat_chip_labs_build'
      },
      {
        prompt: 'How do you take an experiment to production?',
        label: 'Experiment to production?',
        track: 'hero_chat_chip_labs_to_prod'
      }
    ],
    dialog: [
      {
        prompt: 'Where do production habits show up in these builds?',
        label: 'Production habits?',
        track: 'chat_dialog_chip_labs_habits'
      },
      {
        prompt: 'Tell me about the Monday Rover.',
        label: 'Monday Rover?',
        track: 'chat_dialog_chip_monday_rover'
      },
      {
        prompt: 'How do you build under tight constraints — cost, latency, device?',
        label: 'Tight constraints?',
        track: 'chat_dialog_chip_labs_constraints'
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
}

/** Empty transcript copy — chips + rotating placeholders follow the active section (Home / Portfolio / Labs). */
const CHAT_EMPTY_HINT_BY_SECTION = {
  home: "Pick a suggestion below, or type your question. Ask about Marwan's services, projects, and how he works.",
  portfolio: "Pick a suggestion below, or type your question. Ask about his roles, the systems he shipped, and the migrations he led.",
  labs: "Pick a suggestion below, or type your question. Ask about Marwan's experiments and how he takes them to production."
}

const CHAT_VOICE_EMPTY_HINT_BY_SECTION = {
  home: "Start voice chat to ask about Marwan's services, projects, and how he works — or type below and pick a suggestion.",
  portfolio: "Start voice chat to ask about his roles, the systems he shipped, and the migrations he led — or type below and pick a suggestion.",
  labs: "Start voice chat to ask about Marwan's experiments and how he takes them to production — or type below and pick a suggestion."
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
  let suppressDialogChipActivationUntil = 0

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

  const mountDialogPlaceholderChip = (detail) => {
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

  const renderDialogPlaceholderChips = (detail) => {
    const waitMs = suppressDialogChipActivationUntil - Date.now()
    if (waitMs > 0) {
      setTimeout(() => mountDialogPlaceholderChip(detail), waitMs)
      return
    }
    mountDialogPlaceholderChip(detail)
  }

  const endpoint = chatApiUrl || CHAT_DEFAULT_PATH
  // L2 (ADR-0026 §5.3): one throwaway warm POST on the first chat-open intent (launcher hover
  // or focus, or the panel opening), so the stream Lambda's cold start is paid before the
  // visitor's first message. Same endpoint and same digest seam as a real turn; once per page.
  const chatPrewarm = createChatPrewarm({
    chatApiUrl: endpoint,
    fetchImpl: (url, opts) => fetch(url, opts),
    buildRequest: buildChatRequest
  })
  const exposeModelInfo = window.__CHAT_DEBUG_MODEL__ === true

  // Language selector — value sent with every /api/chat request so the
  // backend can instruct the model to respond in that language. Persisted in
  // localStorage so reload keeps the choice; initial pick prefers the
  // browser's primary language if it's in the supported list, else English.
  const LANG_STORAGE_KEY = 'gvp-chat-language'
  const languageSelect = document.getElementById('chatLanguageSelect')
  const SUPPORTED_LANGS = languageSelect
    ? Array.from(languageSelect.options).map((opt) => opt.value)
    : ['en']
  const detectInitialLanguage = () => {
    try {
      const stored = localStorage.getItem(LANG_STORAGE_KEY)
      if (stored && SUPPORTED_LANGS.includes(stored)) return stored
    } catch (_) { /* localStorage blocked — fall through */ }
    const navLang = (navigator.language || 'en').toLowerCase().split('-')[0]
    return SUPPORTED_LANGS.includes(navLang) ? navLang : 'en'
  }
  let currentLanguage = detectInitialLanguage()
  if (languageSelect) {
    languageSelect.value = currentLanguage
    languageSelect.addEventListener('change', () => {
      const next = languageSelect.value
      if (!SUPPORTED_LANGS.includes(next)) return
      currentLanguage = next
      try { localStorage.setItem(LANG_STORAGE_KEY, next) } catch (_) {}
    })
  }

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
    if (!shouldAutofocusChatInput()) return
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
      label.textContent = showConnecting ? 'Connecting…' : 'Start voice chat'
    }
    voiceStartBtn.setAttribute(
      'aria-label',
      showConnecting ? 'Connecting voice…' : 'Start voice chat',
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
    if (action.section) {
      button.dataset.section = action.section
    }
    if (action.project) {
      button.dataset.project = action.project
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
    // ss3.2's second chat.js-owned field, bridged from chat-live.js through this existing
    // patch point. Without it `voiceActive` stayed false forever: the wire carried a lie,
    // ss6.4 persisted that lie on every turn as the admin panel's "was this during a call",
    // and siteStateWireIfNotable's voiceActive clause was unreachable. 'system' because the
    // transport coming up or going down is neither the visitor nor the agent acting.
    setVoiceActive(Boolean(liveUi.active || liveUi.sessionOpen), { origin: 'system' })
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

  // ---------------------------------------------------------------- the stage (ADR-0015 ss4)
  //
  // The chat has four stages, and a site event no longer COMMANDS it to close - it reports
  // what changed, and the pure reducer in js/chat-stage.js decides what that means. The old
  // chain (js/app.js -> collapseChatDialog -> closePanel -> snapClose -> stopVoice) is gone:
  // it is why the assistant's own navigate_to_section tore down the session that had just
  // promised the move (ss9.1).
  //
  // The 768px query lives HERE and nowhere in the reducer: ctx.wide is injected, so the
  // reducer stays pure and testable without a DOM (ss4.2).
  let chatStage = 'closed'
  const isWideViewport = () => (
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 768px)').matches
      : true
  )

  // ---------------------------------------------------------------- size (ADR-0027)
  //
  // The docked card's SIZE is chat-local and orthogonal to the stage: never a reducer input,
  // never a store field. `chatSize` is the visitor's PREFERENCE; what renders is
  // dockedSizeChrome's effective size, which falls back to compact (beside a dialog, on a
  // narrow window) without ever overwriting the preference. Read once, here, from
  // localStorage - blocked or junk storage reads as the wide default.
  const CHAT_SIZE_STORAGE_KEY = 'gvp-chat-size'
  let chatSize = 'wide'
  try {
    chatSize = parseChatSize(localStorage.getItem(CHAT_SIZE_STORAGE_KEY))
  } catch (_) { /* storage blocked - the default stands */ }
  // null = not beside a project dialog; a number = beside one, at that measured width.
  let besideDialogWidth = null
  const sizeToggle = dialog?.querySelector('[data-chat-size-toggle]') || null

  // The ONLY writer of data-chat-size / --chat-dock-width, from dockedSizeChrome alone.
  const applyChatSize = () => {
    const chrome = dockedSizeChrome({
      stage: chatStage,
      viewportWidth: window.innerWidth,
      preferred: chatSize,
      besideDialogWidth
    })
    dialog.dataset.chatSize = chrome.size
    // Docked BESIDE a project dialog by request: css/chat.css lifts exactly this card above
    // the dialog's inset:0 scrim (z 1100), which otherwise covered it (measured, ADR-0027 §9).
    // It only docks beside when it fits without overlapping the panel, so it covers scrim.
    dialog.dataset.chatBeside = chatStage === 'docked' && besideDialogWidth !== null ? 'true' : 'false'
    // 0 = unmeasurable: drop the property so the CSS fallback (the shipped compact rule) holds.
    if (chrome.width > 0) dialog.style.setProperty('--chat-dock-width', `${chrome.width}px`)
    else dialog.style.removeProperty('--chat-dock-width')
    // Attributes only - the button is never re-rendered or moved, so focus stays on it. Its
    // aria-label is FIXED in the markup and never written here.
    if (sizeToggle) {
      sizeToggle.hidden = chrome.toggleHidden
      sizeToggle.setAttribute('aria-pressed', chrome.togglePressed)
    }
  }

  // stageChrome returns the accessibility contract as DATA; this is the only place that
  // turns it into attributes. Each field is a defect that shipped or nearly did:
  //  - backdropHidden: the backdrop is a real inset:0 element with backdrop-filter
  //    (index.html:299). Fading it would leave the site visually operable and dead to clicks.
  //  - scrollLock: body.chat-dialog-open sets overflow:hidden (css/chat.css:1-3).
  //  - ariaModal: STATIC "true" in the markup (index.html:300). A yielded card still
  //    claiming it tells a screen reader the rest of the page does not exist.
  const applyStageChrome = (stage) => {
    const chrome = stageChrome(stage)
    dialog.hidden = chrome.dialogHidden
    dialog.setAttribute('aria-hidden', chrome.dialogHidden ? 'true' : 'false')
    dialog.dataset.chatStage = stage
    if (backdrop) {
      backdrop.hidden = chrome.backdropHidden
      backdrop.setAttribute('aria-hidden', 'true')
    }
    document.body.classList.toggle('chat-dialog-open', chrome.scrollLock)
    panel?.setAttribute('aria-modal', chrome.ariaModal)
    dialog.style.pointerEvents = chrome.pointerEventsOnShell
  }

  /** Apply a stage: chrome, local field, store. Never routes through closePanel. */
  const applyStage = (stage, origin) => {
    // Measured BEFORE the chrome applies: once the card is a pill the composer that held
    // focus is gone, and the question is where focus WAS (ADR-0027 §5.2).
    const active = document.activeElement
    const focusInside = Boolean(active && panel && panel.contains(active))
    chatStage = stage
    applyStageChrome(stage)
    applyChatSize()
    setChatStage(stage, { origin })
    // After the store write, so the resume chip is already un-hidden and can take focus.
    if (stageChrome(stage, { requested: origin === 'visitor', focusInside }).moveFocus === 'resume-chip') {
      document.getElementById('agentActiveChip')?.focus()
    }
  }

  /**
   * Feed one event to the reducer and land wherever it says.
   *
   * `closed` is the one stage that goes through closePanel, because closing is more than
   * chrome (animation, focus restore, the voice stop the VISITOR is entitled to). Everything
   * else is chrome only - which is the whole point: a yield must not touch the session.
   */
  const dispatchStage = (event, origin, extraCtx = {}) => {
    const next = nextChatStage(chatStage, event, { wide: isWideViewport(), ...extraCtx })
    if (next === chatStage) return
    if (next === 'closed') {
      closePanel({ restoreFocus: origin === 'visitor', immediate: true })
      return
    }
    applyStage(next, origin)
  }

  // Which store field means which reducer event. chatStage and voiceActive are js/chat.js's
  // OWN fields (ss3.2), so they map to nothing - that is what keeps the subscription from
  // feeding its own writes back into the reducer.
  const stageEventForChange = (change) => {
    if (change.field === 'section') return 'navigate'
    if (change.field === 'project') return change.to ? 'project-open' : 'project-close'
    if (change.field === 'contactOpen') return change.to ? 'contact-open' : 'contact-close'
    return null
  }

  // The DOM has to agree with the stage from the first frame, not from the first tap.
  // index.html hard-codes aria-modal="true" on the panel and nothing set data-chat-stage
  // until an open — so between load and first open the markup claimed a modal that did not
  // exist, and every stage rule in css/chat.css had no hook to match. No store write here:
  // 'closed' is already the initial value, so a write would be a same-value no-op anyway.
  applyStageChrome('closed')
  applyChatSize()

  // M4 slice 15 (ADR-0017 §6): the launcher chip. Reads chatStage and voiceActive ONLY - a
  // label that changed as the visitor browsed would be the opposite of "your conversation is
  // still here". Its tap is `restore`, which the reducer refuses from `closed`, so a wrongly
  // visible chip can only fail to restore, never cold-open a conversation.
  const activeChip = document.getElementById('agentActiveChip')
  const syncActiveChip = (snapshot) => {
    if (!activeChip) return
    const live = snapshot.chatStage !== 'closed'
    activeChip.hidden = !live
    activeChip.textContent = snapshot.voiceActive ? 'Voice live' : 'Assistant active'
  }
  activeChip?.addEventListener('click', () => {
    trackEvent('chat_launcher_resume', { stage: chatStage })
    dispatchStage('restore', 'visitor')
  })
  // The minimise control (docked card only, per css/chat.css). Ships with the chip because a
  // minimise button with no visible way back is a trapdoor.
  dialog?.querySelector('.chat-dialog__minimize')?.addEventListener('click', (event) => {
    event.stopPropagation()
    dispatchStage('minimize', 'visitor')
  })

  // A resize re-resolves the EFFECTIVE size (wide <-> compact across 840px); the preference
  // is untouched, so widening again brings wide back on its own.
  window.addEventListener('resize', () => { applyChatSize() }, { passive: true })

  // ADR-0027 §4.1: the size toggle. Flips the PREFERENCE, persists it, re-applies the size -
  // and nothing else: no dispatchStage (size is not a stage), no focus() (the button is not
  // re-rendered, so focus stays on it), nothing voice (invariant #20). stopPropagation, like
  // minimise, so the dialog's own click handler never sees it.
  sizeToggle?.addEventListener('click', (event) => {
    event.stopPropagation()
    chatSize = chatSize === 'wide' ? 'compact' : 'wide'
    try { localStorage.setItem(CHAT_SIZE_STORAGE_KEY, chatSize) } catch (_) { /* lives for the page */ }
    applyChatSize()
    trackEvent('chat_size_toggle', { to: chatSize })
  })

  subscribeSiteState((snapshot, change) => {
    syncActiveChip(snapshot)
    if (!change) return
    // The project dialog closed: the card is no longer beside anything, so a temporary
    // compact gives way to the visitor's stored size (ADR-0027 §7).
    if (change.field === 'project' && !change.to && besideDialogWidth !== null) {
      besideDialogWidth = null
      applyChatSize()
    }
    const event = stageEventForChange(change)
    if (!event) return
    // 'system': a layout-driven stage change is neither the visitor moving the chat nor the
    // agent doing it (ss3.3). Mislabelling it would make ss7's live note either announce
    // something the visitor did not do, or dedupe away a note the agent does need.
    dispatchStage(event, 'system')
  })

  const snapClose = ({ restoreFocus = true, keepVoice = false } = {}) => {
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
    //
    // keepVoice: project invariant #20 (ADR-0015 §8) - a site-layout or navigation change
    // must NEVER end a live voice session. The reason above is sound for the VISITOR closing
    // the dialog, and is kept for that. But a navigation, a project dialog or the contact
    // dialog is not the visitor closing the chat: it is the assistant being asked to move the
    // site, often by its OWN navigate_to_section / open_contact_form call - which tore down
    // the very session that had just promised the action (ADR-0015 §9.1).
    //
    // Gating only the stopVoice, deliberately: the rest of snapClose still runs, so the panel
    // still collapses and this is not a no-op. ADR-0015 §4 later replaces the collapse with a
    // stage reducer (docked / minimized rather than closed); this keeps the voice session
    // alive in the meantime without pre-empting that design.
    if (
      !keepVoice
      && (
        liveVoice?.isSessionOpen?.()
        || liveUi.connecting
        || liveUi.active
        || voiceStartRequested
      )
    ) {
      liveVoice?.stopVoice?.({ silent: true })
    }
    clearVoiceAwaitingStart()
    dockMode = 'voice'
    besideDialogWidth = null
    applyStage('closed', 'visitor')
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

  const armDialogChipActivationGuard = () => {
    suppressDialogChipActivationUntil = Date.now() + DIALOG_CHIP_ACTIVATION_GUARD_MS
  }

  const openPanel = ({ mode = 'text' } = {}) => {
    chatPrewarm.trigger()
    const wantVoice = mode === 'voice'
    if (isOpen()) {
      // A yielded panel is still "open" — stageChrome keeps the dialog in the DOM for
      // docked and minimized, so isOpen() (!dialog.hidden) is true for both. The visitor
      // asking for the chat has to PROMOTE it, or tapping a launcher while it sits
      // minimised would set the dock mode and return with nothing moving on screen, and on
      // a narrow viewport that is a conversation with no way back to it.
      const promoted = nextChatStage(chatStage, wantVoice ? 'open-voice' : 'open-text', {
        wide: isWideViewport()
      })
      if (promoted !== chatStage) applyStage(promoted, 'visitor')
      setDockMode(wantVoice ? 'voice' : 'text', {
        awaitingVoice: wantVoice
      })
      return
    }
    armDialogChipActivationGuard()
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
    // THROUGH THE REDUCER (ADR-0027 §2.5): on a wide viewport an open lands the docked card -
    // the main window - and only a narrow one takes the screen. A literal 'modal' here is the
    // one-line regression invariant #27 names.
    applyStage(
      nextChatStage(chatStage, wantVoice ? 'open-voice' : 'open-text', { wide: isWideViewport() }),
      'visitor'
    )
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
        // Hand the panel back to the stylesheet once the seed animation is over. Left in
        // place, this INLINE transition overrides css/chat.css's docked size transition for
        // the life of the panel, so every wide <-> compact toggle snapped (ADR-0027 W7,
        // found by the browser journey). A timeout, like closePanel's fallback, rather than
        // transitionend alone, which does not fire if the transform never actually changed.
        panelAnim.timeout = setTimeout(() => {
          panelAnim.timeout = null
          clearPanelAnimation()
        }, PANEL_ANIM_MS + 80)
      })
    }

    requestAnimationFrame(() => {
      syncEmptyState()
      autosizeComposer()
      reconcileComposerControls()
      reconcileVoicePane()
    })
  }

  const closePanel = ({ restoreFocus = true, immediate = false, keepVoice = false } = {}) => {
    if (!isOpen()) return
    clearPanelAnimation()
    if (immediate || prefersReducedMotion()) {
      snapClose({ restoreFocus, keepVoice })
      return
    }

    const token = ++panelAnim.token
    const seedRect = readSeedRect()
    if (!seedRect) {
      snapClose({ restoreFocus, keepVoice })
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
      snapClose({ restoreFocus, keepVoice })
    }

    panelAnim.endHandler = (event) => {
      if (event.target !== panel || event.propertyName !== 'transform') return
      finish()
    }
    panel.addEventListener('transitionend', panelAnim.endHandler)
    panelAnim.timeout = setTimeout(finish, PANEL_ANIM_MS + 80)
    panel.style.transform = toTransform
  }

  const openContactFromChat = (prefill, opts) => {
    // No closePanel here any more. js/contact.js writes contactOpen, the subscription above
    // feeds `contact-open` to the reducer, and the panel MINIMISES. The old version closed
    // the panel synchronously, which is what dropped the tool response for the assistant's
    // own open_contact_form call: stopVoice nulled chat-live's `ws` before the send-guard
    // ran, so the model waited forever on a function response (ADR-0015 ss9.3 c1).
    openContactDialog(undefined, opts)
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

  // Guided-tour state (see runTourStep). The controls are a card OUTSIDE the chat (#tourCard):
  // a header bar inside the chat broke the docked card's layout and overflowed the narrow
  // pill, sat under the project card a stop opens, and left the narration in a transcript the
  // pill hides. Declared here because a fresh conversation ends any tour.
  const tourCard = document.getElementById('tourCard')
  const tourCardText = document.getElementById('tourCardText')
  const tourCardNext = document.getElementById('tourCardNext')
  const tourCardEnd = document.getElementById('tourCardEnd')
  const tourCardContact = document.getElementById('tourCardContact')
  let tourNext = null
  let tourStepShown = null
  // While the contact form is open the card steps aside: it would sit over the form's Send
  // button on a phone, and a Next stop behind a modal would move the page under it.
  const tourCardBlocked = () => Boolean(getSiteState().contactOpen)
  const renderTourCard = () => {
    if (!tourCard) return
    tourCard.hidden = !tourStepShown || tourCardBlocked()
  }
  const showTourCard = (step) => {
    tourNext = step && Number.isInteger(step.next) ? step.next : null
    tourStepShown = step || null
    if (step) {
      if (tourCardText) tourCardText.textContent = step.say
      if (tourCardNext) tourCardNext.hidden = tourNext === null
      if (tourCardContact) tourCardContact.hidden = tourNext !== null
      if (tourCardEnd) tourCardEnd.textContent = tourNext === null ? 'Done' : 'End tour'
    }
    renderTourCard()
  }
  subscribeSiteState((_snapshot, change) => {
    if (change && change.field === 'contactOpen') renderTourCard()
  })

  const resetConversation = ({ focusTarget = 'composer' } = {}) => {
    messagesEl.textContent = ''
    showTourCard(null)
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
    if (focusTarget === 'hero' && shouldAutofocusChatInput()) {
      agentInput.focus()
      return
    }
    if (isOpen() && shouldAutofocusChatInput()) {
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

  const readSseChat = async (stream, onDelta) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let reply = ''
    let model = ''
    let actions = []
    let sawDone = false

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sepIdx
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sepIdx)
          buffer = buffer.slice(sepIdx + 2)

          let event = 'message'
          let dataLines = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) {
              event = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).replace(/^ /, ''))
            }
          }
          const raw = dataLines.join('\n').trim()
          if (!raw) continue

          let parsed
          try { parsed = JSON.parse(raw) } catch (_) { parsed = null }
          if (!parsed || typeof parsed !== 'object') continue

          if (event === 'token' && typeof parsed.delta === 'string') {
            reply += parsed.delta
            if (typeof onDelta === 'function') onDelta(parsed.delta, reply)
          } else if (event === 'done') {
            sawDone = true
            if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
              reply = parsed.reply
            }
            if (exposeModelInfo && typeof parsed.model === 'string') {
              model = parsed.model
            }
            if (Array.isArray(parsed.actions)) actions = parsed.actions
          } else if (event === 'error') {
            const detail = parsed.error || parsed.message
            const message = typeof detail === 'string' && detail.trim()
              ? detail.trim()
              : 'The chat service hit an error. Try again shortly.'
            throw new Error(message)
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch (_) { /* ignore */ }
    }

    if (!sawDone && !reply) {
      throw new Error('The chat service returned an unexpected reply. Try again.')
    }
    return { reply, model, actions }
  }

  const postChatOnce = async (history, { onDelta } = {}) => {
    let response
    try {
      // CloudFront + OAC in front of a Lambda Function URL requires the viewer to send
      // `x-amz-content-sha256` over the request body; Lambda rejects unsigned payloads and
      // recomputes the hash over the real bytes (absent / UNSIGNED-PAYLOAD -> 403
      // InvalidSignatureException). Sent unconditionally: ECS and API Gateway ignore it.
      // The body MUST come from buildChatRequest and must not be re-serialized, or the
      // digest stops matching the bytes that go out.
      //
      // siteState goes INSIDE the object passed to buildChatRequest, never merged into the
      // body afterwards - the digest covers the exact bytes, so a payload serialized twice
      // is a 403 at the edge, i.e. the chat is down. Omitted entirely when there is nothing
      // to say (ADR-0015 ss6.2): the server then omits the prompt line rather than telling
      // the model the visitor is on the page it would have assumed anyway.
      const site = siteStateWireIfNotable()
      const { body, headers } = await buildChatRequest({
        messages: history,
        stream: true,
        sessionId: state.sessionId,
        language: currentLanguage,
        ...(site ? { siteState: site } : {})
      })
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          ...headers
        },
        body
      })
    } catch (_) {
      // fetch() rejects on offline / DNS / connection reset — all transient.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw makeRetryableError('You appear to be offline. Check your connection and try again.')
      }
      throw makeRetryableError('Could not reach the chat service. Check your connection and try again.')
    }

    const contentType = response.headers.get('content-type') || ''

    if (!response.ok) {
      const text = await response.text()
      const wantsJson = contentType.includes('application/json')
      let body = null
      if (wantsJson && text.trim()) {
        try { body = JSON.parse(text) } catch (_) { body = null }
      }
      if (response.status === 429) {
        throw makeRetryableError('Service is busy. Try again in a moment.')
      }
      if (response.status >= 500) {
        // Server errors are not retried here (could be a hard failure), but
        // surface them specifically rather than as a generic message.
        throw new Error('The chat service hit an error. Try again shortly.')
      }
      const detail = body?.detail || body?.error
      if (typeof detail === 'string' && detail.trim()) {
        throw new Error(detail.trim())
      }
      throw new Error('Chat request failed. Try again.')
    }

    if (contentType.includes('text/event-stream') && response.body) {
      return await readSseChat(response.body, onDelta)
    }

    // Fallback: legacy JSON response (e.g. Lambda buffering, or hosts that
    // downgraded stream=true to a buffered response).
    const text = await response.text()
    const wantsJson = contentType.includes('application/json')
    if (!wantsJson || !text.trim()) {
      throw new Error('The chat service returned an unexpected reply. Try again.')
    }
    let body
    try { body = JSON.parse(text) } catch (_) { body = null }
    if (body === null || typeof body !== 'object') {
      throw new Error('The chat service returned an unexpected reply. Try again.')
    }
    const reply = typeof body?.reply === 'string' ? body.reply : ''
    const model = exposeModelInfo && typeof body?.model === 'string'
      ? body.model
      : ''
    const actions = Array.isArray(body?.actions) ? body.actions : []
    if (reply && typeof onDelta === 'function') onDelta(reply, reply)
    return { reply, model, actions }
  }

  const postChat = async (history, opts = {}) => {
    let lastError = null
    for (let attempt = 0; attempt <= CHAT_MAX_RETRIES; attempt++) {
      try {
        return await postChatOnce(history, opts)
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
    } else if (source === 'project_chip') {
      // Already counted as project_assistant_chip at the tap; not a composer submit.
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
    const pendingTextEl = pendingAssistant.querySelector('.chat-msg__text')
    let firstDeltaSeen = false

    const onDelta = (_delta, accumulated) => {
      if (pendingTextEl) pendingTextEl.textContent = accumulated
      if (!firstDeltaSeen) {
        firstDeltaSeen = true
        chatBus.emit('streaming', { source })
      }
      scrollMessagesToBottom(false)
    }

    try {
      chatBus.emit('thinking', { source })
      const { reply, model, actions } = await postChat(state.history, { onDelta })
      if (actions.length > 0) {
        chatBus.emit('tool_call', { source, actions })
      }
      if (!firstDeltaSeen) chatBus.emit('streaming', { source, model })
      // Track C item 5: the agent's navigation RUNS, as it does on voice. The visitor asked
      // to be shown; a button they still had to tap was the pre-Track-C text path. Only an
      // action that did not apply stays behind as a button.
      const { remaining, executed, startTour } = runAgentActions(actions)
      // The model sometimes fires a tool (open résumé / navigate / contact) with no
      // prose — derive a useful line tied to what RAN or what is left to tap, never a line
      // that points at a button the page already pressed.
      const safeReply = deriveReplyText(reply, remaining, executed)
      // RECORDED, NEVER ACTED ON (ADR-0015 §5.2). A promise is kept only by a move that
      // actually ran - an executed navigate or tour - so only those translate to the tool
      // name the predicate knows.
      if (hasNavPromiseGap(safeReply, executed.map((a) => ({
        name: a && (a.id === 'navigate' || a.id === 'start-tour') ? 'navigate_to_section' : (a && a.id)
      })))) {
        trackEvent('chat_nav_promise_gap', { modality: 'text' })
      }
      state.history = state.history.concat({ role: 'assistant', content: safeReply })
      finalizeAssistantMessage(pendingAssistant, safeReply, remaining)
      if (startTour) runTourStep(0)
      setStatus('')
      scheduleIdleLifecycle(SUCCESS_IDLE_DELAY_MS, { source, model })
    } catch (error) {
      pendingAssistant.remove()
      setStatus(extractErrorMessage(error), 'error')
      chatBus.emit('error', { source, message: extractErrorMessage(error) })
      scheduleIdleLifecycle(ERROR_IDLE_DELAY_MS, { source })
    } finally {
      setComposerBusy(false)
      if (source === 'composer' && shouldAutofocusChatInput()) {
        composerInput.focus()
      }
    }
  }

  const openPanelWithMessage = (text, source = 'hero', _options = {}) => {
    if (source === 'composer' && Date.now() < suppressDialogChipActivationUntil) return
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
    if (!shouldAutofocusChatInput()) return
    requestAnimationFrame(() => {
      if (!isOpen()) return
      composerInput.focus()
    })
  }

  agentNode?.addEventListener('pointerenter', () => chatPrewarm.trigger())
  agentNodeMic?.addEventListener('focus', () => chatPrewarm.trigger())
  agentInput.addEventListener('focus', () => {
    chatPrewarm.trigger()
    const source = resolveLauncherSource()
    if (source === 'header') {
      trackEvent('header_chat_focus', { surface: 'header' })
      return
    }
    trackEvent('hero_chat_focus', { surface: 'hero' })
  })

  agentInput.addEventListener('click', () => {
    if (state.history.length === 0) return
    // Read chatStage, never the dialog's hidden flag: the dialog stays un-hidden while docked
    // or minimised, so with a minimised conversation this click used to do nothing at all.
    if (chatStage === 'closed') openPanel()
    else if (chatStage !== 'modal') dispatchStage('restore', 'visitor')
  })

  // M4 slice 13 (ADR-0017 §2.5, §7.5): the project chips are open-beside's caller. The
  // MEASUREMENT is here (one rect on the live project panel); the DECISION is
  // hasRoomBesideDialog. The STAGE is decided with the COMPACT width, exactly today's rule
  // (ADR-0027 §3.2); the SIZE beside the dialog is dockedSizeChrome's, fed the same measured
  // width - so wide beside -> compact beside -> modal. No room -> modal, never the pill
  // (untappable under the project backdrop). The prompt is canned + the store's title,
  // never visitor text.
  document.addEventListener('click', (event) => {
    const chip = event.target.closest('#projectDialog [data-project-chip]')
    if (!chip) return
    const project = getSiteState().project
    const prompt = projectChipPrompt(chip.dataset.projectChip, project && project.title)
    if (!prompt) return
    const panelEl = document.querySelector('#projectDialog .project-dialog__panel')
    const rect = panelEl ? panelEl.getBoundingClientRect() : null
    const dialogWidth = rect ? rect.width : 0
    const roomBeside = hasRoomBesideDialog({
      viewportWidth: window.innerWidth,
      dialogWidth,
      cardWidth: dockedCardWidth({ viewportWidth: window.innerWidth, size: 'compact' }),
      gutter: DOCK_GUTTER
    })
    // Set BEFORE the stage applies, so the first frame beside the dialog is already the
    // right size. Cleared when the dialog closes (project -> null) or the chat closes. Only
    // when there IS room: a no-room modal that later yields to docked overlaps the panel,
    // and must stay a plain yield below the dialog rather than be lifted above it.
    besideDialogWidth = roomBeside ? dialogWidth : null
    trackEvent('project_assistant_chip', { chip: chip.dataset.projectChip, beside: roomBeside })
    // Opening is more than chrome, so a closed chat opens through openPanel first; open-beside
    // then docks it beside the card when there is room.
    if (chatStage === 'closed') openPanel()
    dispatchStage('open-beside', 'visitor', { roomBeside })
    // Docked -> docked is a same-stage no-op in dispatchStage, so re-resolve the size here.
    applyChatSize()
    // A REQUESTED dock moves focus to the composer (stageChrome(..., { requested: true })) -
    // once the reply settles, because the composer is disabled while it is pending and a
    // disabled input cannot take focus (measured: focus stayed on the project dialog's X).
    // DURING A LIVE CALL the prompt goes to the call (staging voice pass, 2026-10-23: it went
    // down the text path, so a visitor in voice got a text answer and the voice model never
    // heard the question). The bubble is drawn here because a text turn produces no input
    // transcription for chat-live to draw.
    if (liveVoice && typeof liveVoice.sendUserText === 'function' && liveVoice.isSessionOpen?.()
      && liveVoice.sendUserText(prompt)) {
      appendMessage('user', prompt, { forceScroll: true })
      state.history = state.history.concat({ role: 'user', content: prompt })
      return
    }
    void sendMessage(prompt, 'project_chip').finally(() => {
      if (chatStage === 'closed') return
      if (stageChrome(chatStage, { requested: true }).moveFocus !== 'composer') return
      // Next task: the busy flag clears after the send promise settles. setTimeout, not
      // requestAnimationFrame, which never fires in a background tab.
      setTimeout(() => {
        if (chatStage !== 'closed' && !composerInput.disabled) composerInput.focus()
      }, 0)
    })
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
    if (Date.now() < suppressDialogChipActivationUntil) return
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

    // THROUGH THE REDUCER, and the guard above is why this had to change. isOpen() is
    // `!dialog.hidden`, and stageChrome deliberately keeps the dialog in the DOM for docked
    // AND minimized - so this handler fired while the chat was yielded and ran closePanel
    // with keepVoice false, which reaches stopVoice. One keystroke: a visitor on a live
    // call taps a project card, the chat minimises correctly, they press Escape to dismiss
    // THE PROJECT DIALOG, and the call dies (js/dialog-helpers.js does not stopPropagation,
    // so both handlers run). Invariant #20, broken by a key aimed at something else.
    if (chatStage !== 'modal') {
      // Not ours to swallow: another dialog is in front of the visitor and its own Escape
      // handler still has to run, so no preventDefault. `minimize` -> `minimized` is a
      // no-op in the reducer, which is the point (ss4.3: a pill has nothing to dismiss, and
      // destroying the conversation on a stray keystroke would discard the transcript).
      dispatchStage('escape', 'visitor')
      return
    }
    event.preventDefault()
    const hasActiveTransition = Boolean(panelAnim.timeout || panelAnim.endHandler)
    closePanel({ immediate: hasActiveTransition })
  })

  // A docked card is sized for a wide viewport; left in place when the window narrows it
  // covers the content it exists to make room for. 'system' because a resize is neither the
  // visitor moving the chat nor the agent doing it (ss3.3).
  if (typeof window.matchMedia === 'function') {
    const wide = window.matchMedia('(min-width: 768px)')
    const onViewport = (e) => {
      dispatchStage(e && e.matches ? 'viewport-wide' : 'viewport-narrow', 'system')
    }
    if (typeof wide.addEventListener === 'function') wide.addEventListener('change', onViewport)
  }

  dialog.addEventListener('click', (event) => {
    // At the minimised size the panel renders as the header alone — a title and a close X
    // (MEASURED in the browser) — so the pill itself has to be the way back, or a visitor
    // whose only visible control says "close" can lose a live conversation to a mis-tap.
    // Only when minimised: a docked card is a usable panel, and promoting it on any click
    // would mean the first tap in the transcript yanked them into a full-screen modal.
    // `restore` is a visitor act, not a side effect of using what is already on screen.
    // Before the data-action/dock-switch checks, so the close X still closes.
    if (chatStage === 'minimized'
      && !event.target.closest('[data-action]')
      && !event.target.closest('.chat-dialog__close')) {
      dispatchStage('restore', 'visitor')
      return
    }
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
    if (action === 'navigate') {
      // The return value used to be discarded here, so an assistant-rendered button for a
      // section that did not resolve was a silent no-op: the visitor tapped and nothing
      // happened, and neither they, nor the model, nor analytics learned it had failed
      // (ADR-0015 §9.2 — the text path failed worse than the voice path, which at least
      // round-tripped the error). It stays non-interrupting: a visitor who tapped a button
      // does not need an error bubble, but the failure has to be countable.
      const outcome = navigateToSection(actionEl.dataset.section || '', 'visitor')
      if (outcome.error) {
        trackEvent('chat_nav_unresolved', { section: String(actionEl.dataset.section || '') })
      }
      return
    }
    if (action === 'open-contact') {
      openContactFromChat(parsePrefill(actionEl.dataset.prefill))
      return
    }
    if (action === 'open-project') {
      const match = requestProjectOpen(actionEl.dataset.project || '', { origin: 'visitor' })
      if (match && match.error) trackEvent('chat_project_unresolved', { reason: 'unknown_project' })
      return
    }
    if (action === 'close-project') {
      requestProjectClose({ origin: 'visitor' })
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

  const onOpenChatEvent = (event) => {
    // Unified "chat opened" event for footer / spaceman / programmatic entry points
    // (the hero paths emit their own focus/submit events). Carries the chat sessionId so
    // the per-session site timeline can deep-link to the matching chat transcript. A caller
    // may name its surface (the footer does), so the admin rollup can tell them apart.
    trackEvent('chat_open', {
      surface: (event && event.detail && event.detail.surface) || 'event',
      chatSessionId: state.sessionId
    })
    openPanel({ mode: 'text' })
    reconcileComposerControls()
  }
  window.addEventListener(EV_OPEN_CHAT, onOpenChatEvent)

  // Dispatch tool calls emitted by the Live API in voice mode. Mirrors the
  // text-chat action handler below: same destinations, no buttons (voice executes
  // immediately). Return value is sent back as toolResponse.response so the model
  // knows the action ran.
  // Move the page to a top-level section so the agent can SHOW the visitor around
  // (text and voice share this one routine). Returns a tool-response-shaped result.
  // Routing belongs to the router. This used to be a chain of byte-exact `===` plus its own
  // URL writes, which is how two defects got in: "Portfolio" fell through to
  // unknown_section (ADR-0015 ss9.2), and assigning the fragment the document already has
  // dispatches no hashchange, so the section was never applied while the tool still reported
  // `navigated` (ss9.4). js/navigation.js's requestNavigation resolves through the shared
  // registry, moves the page, and labels the store write `agent` - which only the caller
  // knows, since a hashchange cannot say who caused it.
  const navigateToSection = (raw, origin = 'agent') => {
    const target = requestNavigation(raw, { origin })
    if (target.error) {
      return { error: `unknown_section: ${raw}`, received: raw, siteState: getSiteStateForWire() }
    }
    // READ BACK, never the argument spelled twice (ADR-0015 ss5.1, invariant #21). An echo
    // built from the request agrees with it by construction, which is precisely the property
    // a self-verification contract must not have - and the no-op hash write (ss9.4) is the
    // measured case where it would have lied outright.
    //
    // Synchronous, where the ADR specified a 250ms wait: that wait existed because the old
    // code moved the page by assigning window.location.hash and waited for the hashchange to
    // come back round. requestNavigation calls applySection directly, so the store is
    // already settled here. The error case stays - that is the half #21 is about.
    const settled = getSiteState()
    if (settled.section !== target.id) {
      return { error: 'navigation_did_not_apply', section: target.id, siteState: getSiteStateForWire() }
    }
    return { result: 'navigated', section: settled.section, siteState: getSiteStateForWire() }
  }

  // Execute the text path's page-moving actions (Track C item 5). Navigation and project
  // cards are the agent's moves, labelled `agent` like voice's; the résumé and the contact
  // form stay buttons - a new tab and a form are the visitor's to open.
  const runAgentActions = (actions) => {
    const remaining = []
    const executed = []
    let startTour = false
    for (const a of Array.isArray(actions) ? actions : []) {
      if (a && a.id === 'start-tour') {
        startTour = true
        executed.push(a)
        continue
      }
      if (a && a.id === 'navigate') {
        const outcome = navigateToSection(a.section || '')
        if (!outcome.error) {
          executed.push(a)
          continue
        }
        trackEvent('chat_nav_unresolved', { section: String(a.section || '') })
      }
      if (a && a.id === 'open-project') {
        // READ BACK, as the voice path does: openDialog returns early until loadProjects has
        // filled the registry, so a resolved id is not proof the card is on screen.
        const match = requestProjectOpen(a.project || '', { origin: 'agent' })
        const settled = getSiteState().project
        if (match && !match.error && settled && settled.id === match.id) {
          executed.push(a)
          continue
        }
        trackEvent('chat_project_unresolved', { reason: match && match.error ? 'unknown_project' : 'did_not_open' })
      }
      remaining.push(a)
    }
    return { remaining, executed, startTour }
  }

  // One stop of the guided tour (js/tour.js): move the page, then say the line - on the tour
  // card, and in the transcript and history so the model knows where the tour has taken the
  // visitor. Next stop reads `tourNext`, so nothing stale can re-run a stop.
  // `origin`: the FIRST stop is the agent's (it answered a tool call, and the tool result tells
  // the model); every later stop is the VISITOR's tap on Next stop - labelled so, which is also
  // what lets a live voice session hear where the tour went (js/site-state-notes.js skips
  // agent-origin changes as already known).
  const runTourStep = (index, origin = 'agent') => {
    const step = tourStep(index)
    if (!step) return null
    for (const move of step.moves) {
      if (move.kind === 'close-project') requestProjectClose({ origin })
      else if (move.kind === 'navigate') navigateToSection(move.section, origin)
      else if (move.kind === 'open-project') requestProjectOpen(move.project, { origin })
    }
    appendMessage('assistant', step.say, { actions: step.actions, forceScroll: true })
    state.history = state.history.concat({ role: 'assistant', content: step.say })
    showTourCard(step)
    trackEvent('chat_tour_step', { step: index })
    return step
  }

  tourCardNext?.addEventListener('click', () => {
    if (tourNext !== null && !tourCardBlocked()) runTourStep(tourNext, 'visitor')
  })
  tourCardEnd?.addEventListener('click', () => {
    const finished = tourNext === null
    showTourCard(null)
    if (finished) return
    const line = 'No problem. Ask me anything, or open any card to dig in.'
    appendMessage('assistant', line, { forceScroll: true })
    state.history = state.history.concat({ role: 'assistant', content: line })
    trackEvent('chat_tour_end', {})
  })
  tourCardContact?.addEventListener('click', () => {
    showTourCard(null)
    openContactFromChat(null)
  })

  const applyVoiceToolCall = (name, args) => {
    if (name === 'open_resume') {
      // Parity with text chat: don't yank the visitor into a new tab. Reveal the
      // download button and let the agent ask them to tap it (the dialog click
      // handler above opens the PDF on tap).
      appendMessage('assistant', "Here's Marwan's résumé — tap to open it.", {
        actions: [{ id: 'open-resume', label: 'Open resume' }],
        forceScroll: true,
      })
      // Keep the tool response minimal: the "ask them to tap the button" guidance
      // lives in the tool DESCRIPTION. A second copy here made the voice model say
      // it twice (the rambling, run-on reply). The button is already on screen.
      return { result: 'resume_button_shown' }
    }
    if (name === 'open_contact_form') {
      const prefill = args && typeof args === 'object'
        ? { subject: typeof args.subject === 'string' ? args.subject : '',
            message: typeof args.message === 'string' ? args.message : '' }
        : null
      openContactFromChat(prefill, { origin: 'agent' })
      // READ BACK, and this is the one place invariant #21's "did not apply -> error"
      // clause is reachable: openContactDialog is a no-op until initContactForm has run,
      // and that returns early when any of seven DOM nodes is missing. Without the check
      // the tool reported success, the voice model said so out loud, and the echoed
      // siteState sitting beside it said contactOpen: false.
      if (!getSiteState().contactOpen) {
        return { error: 'contact_form_did_not_open', siteState: getSiteStateForWire() }
      }
      // The whole state travels, not just the field the tool touched - the model should not
      // have to remember where the visitor was to know where they still are.
      return { result: 'opened_contact_form', siteState: getSiteStateForWire() }
    }
    if (name === 'open_project') {
      const ref = args && typeof args.project === 'string' ? args.project : ''
      const match = requestProjectOpen(ref, { origin: 'agent' })
      if (match.error) {
        return { error: 'unknown_project', received: ref, siteState: getSiteStateForWire() }
      }
      // READ BACK (invariant #21). The "did not apply" branch is genuinely reachable here:
      // openDialog returns early when the project registry misses, and that registry is
      // populated per card only after loadProjects resolves - and never at all when that
      // fetch fails. So a voice visitor on a slow connection can ask in the first second
      // and, without this, be told a card opened that never did.
      const settled = getSiteState().project
      if (!settled || settled.id !== match.id) {
        return { error: 'project_did_not_open', projectId: match.id, siteState: getSiteStateForWire() }
      }
      return {
        result: 'opened_project',
        projectId: settled.id,
        projectTitle: settled.title,
        siteState: getSiteStateForWire()
      }
    }
    if (name === 'close_project') {
      requestProjectClose({ origin: 'agent' })
      // CLOSING NOTHING IS A SUCCESS, and that is the inverse of the no-op hash write.
      // Invariant #21 is about whether the state the result ASSERTS is true, not about
      // whether work happened: after this the state is "no project open", which is exactly
      // what is reported and may well have been true already. An error here would teach the
      // model that a correct statement about the world is a failure.
      if (getSiteState().project) {
        return { error: 'project_did_not_close', siteState: getSiteStateForWire() }
      }
      return { result: 'closed_project', siteState: getSiteStateForWire() }
    }
    if (name === 'navigate_to_section') {
      const section = args && typeof args.section === 'string' ? args.section : ''
      return navigateToSection(section)
    }
    if (name === 'start_tour') {
      const step = runTourStep(0)
      if (!step) return { error: 'tour_unavailable', siteState: getSiteStateForWire() }
      return { result: 'tour_started', stop: step.say, siteState: getSiteStateForWire() }
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
