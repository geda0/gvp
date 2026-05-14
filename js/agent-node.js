import { chatBus } from './chat-bus.js'

const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'
const HERO_OBSERVER_THRESHOLDS = [0, 0.2, 0.35, 0.6, 1]
const MORPH_LEAVE_DEBOUNCE_MS = 120
const LIFECYCLE_STATES = ['sending', 'thinking', 'streaming', 'tool_call', 'error']

function normalizeSection(section) {
  return section === 'playground' || section === 'portfolio' ? section : 'home'
}

function normalizeSlot(slot) {
  return slot === 'navbar' ? 'navbar' : 'hero'
}

export function initAgentNode(options = {}) {
  const node = document.getElementById('agentNode')
  const heroSlot = document.getElementById('agentSlotHero')
  const navbarSlot = document.getElementById('agentSlotNavbar')
  const trail = document.getElementById('agentTrail')
  const form = node?.querySelector('.agent-node__form')
  const input = node?.querySelector('.agent-node__input')
  const bubble = node?.querySelector('.agent-node__bubble')

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

  const state = {
    section: 'home',
    slot: normalizeSlot(node.dataset.slot),
    mode: node.dataset.state || 'bubble',
    heroVisible: true
  }

  let leaveTimer = null
  let launcherObserver = null
  let unsubscribeChatBus = null

  const clearLeaveTimer = () => {
    if (!leaveTimer) return
    clearTimeout(leaveTimer)
    leaveTimer = null
  }

  const isFinePointer = () => Boolean(mql?.matches)

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
    const safe = nextState === 'bar' || nextState === 'modal' ? nextState : 'bubble'
    state.mode = safe
    node.dataset.state = safe
    syncTrailVisibility()
    options.onStateChange?.(safe)
  }

  const dockTo = (nextSlot = 'hero') => {
    const safeSlot = normalizeSlot(nextSlot)
    const parent = safeSlot === 'hero' ? heroSlot : navbarSlot
    if (!parent) return
    if (node.parentElement !== parent) {
      parent.appendChild(node)
    }
    state.slot = safeSlot
    node.dataset.slot = safeSlot
    options.onDockChange?.(safeSlot)
    if (!isOpen()) {
      setState('bubble')
    }
  }

  const syncFromNavigation = (section = 'home') => {
    state.section = normalizeSection(section)
    if (state.section === 'home') {
      dockTo(state.heroVisible ? 'hero' : 'navbar')
      return
    }
    dockTo('navbar')
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

  input.addEventListener('focus', () => {
    if (isFinePointer() && state.mode !== 'modal') {
      setState('bar')
    }
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

  bubble?.addEventListener('click', () => {
    if (isFinePointer()) return
    if (state.mode === 'modal') return
    openFromNode()
  })

  const applyLifecycleClass = (chatState) => {
    node.classList.remove('agent-node--lifecycle-active')
    trail?.classList.remove('agent-trail--lifecycle-active')
    LIFECYCLE_STATES.forEach((status) => {
      const safe = status.replace('_', '-')
      node.classList.remove(`agent-node--lifecycle-${safe}`)
      trail?.classList.remove(`agent-trail--${safe}`)
    })
    if (!chatState || chatState === 'idle') return
    const safeState = String(chatState).replace('_', '-')
    node.classList.add('agent-node--lifecycle-active', `agent-node--lifecycle-${safeState}`)
    trail?.classList.add('agent-trail--lifecycle-active', `agent-trail--${safeState}`)
  }

  unsubscribeChatBus = chatBus.on((chatState) => {
    applyLifecycleClass(chatState)
  })

  if (typeof IntersectionObserver === 'function') {
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
    dockTo('navbar')
  }

  syncFromNavigation('home')
  syncTrailVisibility()

  const destroy = () => {
    clearLeaveTimer()
    launcherObserver?.disconnect()
    launcherObserver = null
    unsubscribeChatBus?.()
    unsubscribeChatBus = null
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
