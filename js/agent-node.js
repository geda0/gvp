import { chatBus } from './chat-bus.js'

const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const MORPH_LEAVE_DEBOUNCE_MS = 120
const LOUNGE_MSG_MS = 4000
const LOUNGE_ASK_MS = 3600
const LIFECYCLE_STATES = ['sending', 'thinking', 'streaming', 'tool_call', 'error']

const PLACEHOLDER_POOL = {
  home: [
    'Ask anything about Marwan\'s work…',
    'e.g. system design, cloud, or team leadership',
    'What did you ship most recently?',
    'Curious about a specific employer or project?'
  ],
  playground: [
    'Ask about this experiment…',
    'What problem were you exploring?',
    'What would you try differently next time?'
  ],
  portfolio: [
    'Ask about a role or impact metric…',
    'How did you measure success there?',
    'What was the hardest tradeoff on that project?'
  ]
}

function normalizeSection(section) {
  return section === 'playground' || section === 'portfolio' ? section : 'home'
}

function normalizeSlot(slot) {
  return slot === 'navbar' ? 'navbar' : 'hero'
}

const HERO_OBSERVER_THRESHOLDS = [0, 0.2, 0.35, 0.6, 1]

export function initAgentNode(options = {}) {
  const node = document.getElementById('agentNode')
  const heroSlot = document.getElementById('agentSlotHero')
  const navbarSlot = document.getElementById('agentSlotNavbar')
  const trail = document.getElementById('agentTrail')
  const form = node?.querySelector('.agent-node__form')
  const input = node?.querySelector('.agent-node__input')

  if (!node || !heroSlot || !navbarSlot || !form || !input) return null

  const {
    openPanel = () => {},
    openPanelWithMessage = () => {},
    isOpen = () => false,
    spacemanPosition = null
  } = options

  const mql = typeof window.matchMedia === 'function'
    ? window.matchMedia(FINE_POINTER_QUERY)
    : null
  const reducedMql = typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null

  const state = {
    section: 'home',
    slot: normalizeSlot(node.dataset.slot || 'hero'),
    mode: node.dataset.state || 'bubble',
    heroVisible: true
  }

  let leaveTimer = null
  let unsubscribeChatBus = null
  let loungeTimer = null
  let launcherObserver = null
  let lastSyncedSection = 'home'
  const placeholderIdx = { home: 0, playground: 0, portfolio: 0 }
  let barPlaceholderTimer = null

  const prefersReducedMotion = () => Boolean(reducedMql?.matches)

  const isObstructingDialogOpen = () => (
    document.body.classList.contains('chat-dialog-open')
    || document.body.classList.contains('project-dialog-open')
    || document.body.classList.contains('contact-dialog-open')
  )

  const poolForSection = (section) => (
    PLACEHOLDER_POOL[section] || PLACEHOLDER_POOL.home
  )

  const applyPlaceholder = (section, index) => {
    const pool = poolForSection(section)
    const n = Number(index) || 0
    const i = ((n % pool.length) + pool.length) % pool.length
    input.placeholder = pool[i]
  }

  const bumpPlaceholderOnSectionChange = (section) => {
    const pool = poolForSection(section)
    placeholderIdx[section] = (placeholderIdx[section] + 1) % pool.length
    applyPlaceholder(section, placeholderIdx[section])
  }

  const clearBarPlaceholderTimer = () => {
    if (!barPlaceholderTimer) return
    clearInterval(barPlaceholderTimer)
    barPlaceholderTimer = null
  }

  const syncBarPlaceholderRotation = () => {
    clearBarPlaceholderTimer()
    if (prefersReducedMotion() || isOpen()) return
    if (!isFinePointer()) return
    if (state.mode !== 'bar') return
    barPlaceholderTimer = window.setInterval(() => {
      if (isOpen() || node.matches(':focus-within')) return
      const sec = state.section
      placeholderIdx[sec] = (placeholderIdx[sec] + 1) % poolForSection(sec).length
      applyPlaceholder(sec, placeholderIdx[sec])
    }, 4800)
  }

  const syncDimAskClass = () => {
    const dim = state.mode === 'bar'
      || (state.mode === 'bubble' && node.dataset.loungePhase === 'ask')
    node.classList.toggle('agent-node--dim-ask', dim)
  }

  const clearLoungeTimer = () => {
    if (!loungeTimer) return
    clearTimeout(loungeTimer)
    loungeTimer = null
  }

  const clearLeaveTimer = () => {
    if (!leaveTimer) return
    clearTimeout(leaveTimer)
    leaveTimer = null
  }

  const isFinePointer = () => Boolean(mql?.matches)

  const syncInputReadOnly = () => {
    if (isFinePointer() || state.mode === 'modal') {
      input.readOnly = false
      return
    }
    input.readOnly = node.dataset.loungePhase !== 'ask'
  }

  const shouldRunCopyAlternate = () => (
    !prefersReducedMotion()
    && state.mode === 'bubble'
    && !isOpen()
    && !spacemanPosition?.isQuiet
    && !isObstructingDialogOpen()
  )

  const scheduleLoungeFlip = () => {
    clearLoungeTimer()
    if (!shouldRunCopyAlternate()) return
    if (node.matches(':focus-within')) {
      loungeTimer = setTimeout(scheduleLoungeFlip, 640)
      return
    }
    const phase = node.dataset.loungePhase === 'ask' ? 'ask' : 'msg'
    const delay = phase === 'msg' ? LOUNGE_MSG_MS : LOUNGE_ASK_MS
    loungeTimer = setTimeout(() => {
      loungeTimer = null
      if (!shouldRunCopyAlternate()) return
      if (node.matches(':focus-within')) {
        scheduleLoungeFlip()
        return
      }
      const next = phase === 'msg' ? 'ask' : 'msg'
      node.dataset.loungePhase = next
      node.classList.add('agent-node--lounge-tick')
      window.setTimeout(() => node.classList.remove('agent-node--lounge-tick'), 380)
      if (next === 'ask') {
        const sec = state.section
        const pool = poolForSection(sec)
        applyPlaceholder(sec, placeholderIdx[sec])
        placeholderIdx[sec] = (placeholderIdx[sec] + 1) % pool.length
      }
      syncInputReadOnly()
      syncDimAskClass()
      scheduleLoungeFlip()
    }, delay)
  }

  const restartLounge = () => {
    clearLoungeTimer()
    applyPlaceholder(state.section, placeholderIdx[state.section])
    if (prefersReducedMotion()) {
      node.dataset.loungePhase = 'ask'
      syncInputReadOnly()
      syncDimAskClass()
      if (state.mode === 'bar') syncBarPlaceholderRotation()
      return
    }
    if (!shouldRunCopyAlternate()) {
      node.dataset.loungePhase = 'msg'
      syncInputReadOnly()
      syncDimAskClass()
      if (state.mode === 'bar') syncBarPlaceholderRotation()
      return
    }
    node.dataset.loungePhase = 'msg'
    syncInputReadOnly()
    syncDimAskClass()
    scheduleLoungeFlip()
    if (state.mode === 'bar') syncBarPlaceholderRotation()
  }

  const getSlot = () => state.slot

  const getRect = () => {
    const rect = node.getBoundingClientRect()
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom
    }
  }

  const syncTrailVisibility = () => {
    if (!spacemanPosition || typeof spacemanPosition.setTrailVisible !== 'function') return
    const quiet = Boolean(spacemanPosition.isQuiet)
    const dialogOpen = document.body.classList.contains('chat-dialog-open')
      || document.body.classList.contains('project-dialog-open')
      || document.body.classList.contains('contact-dialog-open')
    const visible = state.mode !== 'modal' && !quiet && !dialogOpen
    spacemanPosition.setTrailVisible(visible)
  }

  const setState = (nextState = 'bubble') => {
    const prev = state.mode
    const safe = nextState === 'bar' || nextState === 'modal' ? nextState : 'bubble'
    state.mode = safe
    node.dataset.state = safe
    if (safe === 'bar' || safe === 'modal') clearLoungeTimer()
    if (safe !== 'bar') clearBarPlaceholderTimer()
    syncDimAskClass()
    syncTrailVisibility()
    syncInputReadOnly()
    options.onStateChange?.(safe)
    if (safe === 'bar') syncBarPlaceholderRotation()
    if (prev === 'modal' && safe === 'bubble') {
      requestAnimationFrame(() => restartLounge())
    } else {
      restartLounge()
    }
  }

  const dockTo = (nextSlot = 'hero') => {
    const safe = normalizeSlot(nextSlot)
    const parent = safe === 'navbar' ? navbarSlot : heroSlot
    if (node.parentElement !== parent) {
      parent.appendChild(node)
    }
    state.slot = safe
    node.dataset.slot = safe
    options.onDockChange?.(safe)
    if (!isOpen()) {
      setState('bubble')
    } else {
      restartLounge()
    }
    spacemanPosition?.updatePosition?.()
  }

  const syncHeroVisibleFromRect = () => {
    const r = heroSlot.getBoundingClientRect()
    const vh = window.innerHeight || document.documentElement.clientHeight || 0
    state.heroVisible = r.bottom > 0 && r.top < vh
  }

  const syncFromNavigation = (section = 'home') => {
    const next = normalizeSection(section)
    if (next !== lastSyncedSection) {
      bumpPlaceholderOnSectionChange(next)
      lastSyncedSection = next
    }
    state.section = next
    if (next === 'home') {
      syncHeroVisibleFromRect()
      dockTo(state.heroVisible ? 'hero' : 'navbar')
    } else {
      dockTo('navbar')
    }
    if (
      isFinePointer()
      && !isOpen()
      && state.mode !== 'modal'
      && (node.matches(':hover') || node.matches(':focus-within'))
    ) {
      setState('bar')
    } else {
      syncBarPlaceholderRotation()
    }
  }

  const onPointerEnter = () => {
    if (!isFinePointer()) return
    clearLeaveTimer()
    if (state.mode !== 'modal') {
      setState('bar')
    }
  }

  const queueBubbleMode = () => {
    if (!isFinePointer()) return
    clearLeaveTimer()
    leaveTimer = setTimeout(() => {
      leaveTimer = null
      if (state.mode === 'modal') return
      if (node.matches(':focus-within')) return
      setState('bubble')
    }, MORPH_LEAVE_DEBOUNCE_MS)
  }

  const openFromNode = () => {
    setState('modal')
    openPanel(state.slot)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = String(input.value || '').trim()
    const source = state.slot === 'navbar' ? 'header' : 'hero'
    if (!text) {
      openFromNode()
      return
    }
    input.value = ''
    setState('modal')
    openPanelWithMessage(text, source)
  })

  input.addEventListener('pointerdown', (event) => {
    if (isFinePointer()) return
    if (state.mode === 'modal') return
    if (!input.readOnly) return
    event.preventDefault()
    openFromNode()
  })

  input.addEventListener('focus', () => {
    if (isFinePointer() && state.mode !== 'modal') {
      setState('bar')
    }
  })

  const isBubbleAmbientLineTarget = (target) => (
    Boolean(target?.closest?.('.agent-node__bubble-text'))
    || Boolean(target?.closest?.('.agent-node__cursor'))
  )

  node.addEventListener('click', (event) => {
    if (state.mode !== 'bubble' || isOpen()) return
    if (!isBubbleAmbientLineTarget(event.target)) return
    if (spacemanPosition?.isQuiet) return
    if (prefersReducedMotion()) return
    if (node.dataset.loungePhase === 'ask') {
      event.preventDefault()
      input.focus()
      return
    }
    if (!shouldRunCopyAlternate()) return
    event.preventDefault()
    event.stopPropagation()
    clearLoungeTimer()
    node.dataset.loungePhase = 'ask'
    node.classList.add('agent-node--lounge-tick')
    window.setTimeout(() => node.classList.remove('agent-node--lounge-tick'), 380)
    const sec = state.section
    const pool = poolForSection(sec)
    applyPlaceholder(sec, placeholderIdx[sec])
    placeholderIdx[sec] = (placeholderIdx[sec] + 1) % pool.length
    syncInputReadOnly()
    syncBarPlaceholderRotation()
    syncDimAskClass()
    scheduleLoungeFlip()
  }, true)

  node.addEventListener('click', (event) => {
    if (isFinePointer()) return
    if (state.mode !== 'bubble' || isOpen()) return
    if (event.target.closest('.agent-node__form')) return
    openFromNode()
  })

  node.addEventListener('focusin', onPointerEnter)
  node.addEventListener('pointerenter', onPointerEnter)
  node.addEventListener('pointerleave', queueBubbleMode)
  node.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!node.matches(':focus-within')) {
        queueBubbleMode()
      }
    })
  })

  const applyLifecycleClass = (chatState) => {
    node.classList.remove('agent-node--lifecycle-active')
    trail?.classList.remove('agent-trail--lifecycle-active')
    LIFECYCLE_STATES.forEach((status) => {
      const safe = status.replace(/_/g, '-')
      node.classList.remove(`agent-node--lifecycle-${safe}`)
      trail?.classList.remove(`agent-trail--${safe}`)
    })
    if (!chatState || chatState === 'idle') return
    const safeState = String(chatState).replace(/_/g, '-')
    node.classList.add('agent-node--lifecycle-active', `agent-node--lifecycle-${safeState}`)
    trail?.classList.add('agent-trail--lifecycle-active', `agent-trail--${safeState}`)
  }

  unsubscribeChatBus = chatBus.on((chatState) => {
    applyLifecycleClass(chatState)
  })

  const onFinePointerMqlChange = () => {
    syncTrailVisibility()
    if (!isFinePointer() && state.mode !== 'modal') {
      clearLeaveTimer()
      setState('bubble')
    } else {
      syncInputReadOnly()
      restartLounge()
      syncBarPlaceholderRotation()
    }
  }
  mql?.addEventListener?.('change', onFinePointerMqlChange)

  const onReducedMotionMqlChange = () => {
    clearBarPlaceholderTimer()
    restartLounge()
  }
  reducedMql?.addEventListener?.('change', onReducedMotionMqlChange)

  if (typeof IntersectionObserver === 'function') {
    launcherObserver?.disconnect()
    launcherObserver = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      state.heroVisible = entry.isIntersecting && entry.intersectionRatio >= 0.35
      if (state.section === 'home') {
        dockTo(state.heroVisible ? 'hero' : 'navbar')
      }
    }, {
      root: null,
      rootMargin: '0px',
      threshold: HERO_OBSERVER_THRESHOLDS
    })
    launcherObserver.observe(heroSlot)
  } else {
    state.heroVisible = false
  }

  let bodyClassObserver = null
  let bodyRestartRaf = null
  const scheduleRestartFromBodyClass = () => {
    if (bodyRestartRaf != null) return
    bodyRestartRaf = requestAnimationFrame(() => {
      bodyRestartRaf = null
      if (state.mode === 'modal') return
      restartLounge()
    })
  }

  if (typeof MutationObserver === 'function' && document.body) {
    bodyClassObserver = new MutationObserver(scheduleRestartFromBodyClass)
    bodyClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  }

  syncFromNavigation('home')
  syncTrailVisibility()

  const destroy = () => {
    clearLeaveTimer()
    clearLoungeTimer()
    clearBarPlaceholderTimer()
    launcherObserver?.disconnect()
    launcherObserver = null
    bodyClassObserver?.disconnect()
    bodyClassObserver = null
    if (bodyRestartRaf != null) {
      cancelAnimationFrame(bodyRestartRaf)
      bodyRestartRaf = null
    }
    unsubscribeChatBus?.()
    unsubscribeChatBus = null
    mql?.removeEventListener?.('change', onFinePointerMqlChange)
    reducedMql?.removeEventListener?.('change', onReducedMotionMqlChange)
  }

  return {
    getSlot,
    getRect,
    setState,
    dockTo,
    syncFromNavigation,
    syncTrailVisibility,
    destroy
  }
}
