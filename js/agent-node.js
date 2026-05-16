import { chatBus } from './chat-bus.js'
import { normalizeSection } from './section-names.js'

const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const MORPH_LEAVE_DEBOUNCE_MS = 120
const PLACEHOLDER_ROTATE_MS = 4500
const PLACEHOLDER_CROSSFADE_MS = 160
const LIFECYCLE_STATES = ['sending', 'thinking', 'streaming', 'tool_call', 'error']

const PLACEHOLDER_POOL = {
  home: [
    {
      teaser: 'Services?',
      deepQuestion: 'What services do you offer?'
    },
    {
      teaser: 'Architecture work?',
      deepQuestion: 'What kinds of architecture work do you take on?'
    },
    {
      teaser: 'Data engineering?',
      deepQuestion: 'What kinds of data engineering work do you take on?'
    },
    {
      teaser: 'Production AI?',
      deepQuestion: 'How do you build production AI products?'
    },
    {
      teaser: 'Migrations?',
      deepQuestion: 'What kinds of migrations have you led?'
    },
    {
      teaser: 'Engagement shape?',
      deepQuestion: 'How do you engage — review, build, or lead?'
    }
  ],
  playground: [
    {
      teaser: 'What you can build?',
      deepQuestion: 'What can you build at the experiment scale?'
    },
    {
      teaser: 'Experiment to production?',
      deepQuestion: 'How do you take an experiment to production?'
    },
    {
      teaser: 'Generative Video Platform?',
      deepQuestion: 'Tell me about the Generative Video Platform — what was it exploring?'
    },
    {
      teaser: 'Monday Rover?',
      deepQuestion: 'Tell me about the Monday Rover — the vision loop and what constrained hardware forced you to simplify.'
    },
    {
      teaser: 'Production habits?',
      deepQuestion: 'Where do production habits show up in these builds, and where did you cut corners?'
    },
    {
      teaser: 'Tight constraints?',
      deepQuestion: 'How do you build under tight constraints — cost, latency, device?'
    }
  ],
  portfolio: [
    {
      teaser: 'Architecture proof?',
      deepQuestion: 'Show me architecture work that shipped.'
    },
    {
      teaser: 'Apptio (IBM)?',
      deepQuestion: 'What did you ship at Apptio — pipelines, correctness, migration?'
    },
    {
      teaser: 'JumpCloud (M365)?',
      deepQuestion: 'How did the hybrid Postgres/Mongo + GraphQL design work at JumpCloud under tenant scale?'
    },
    {
      teaser: 'Instant Ink (HP)?',
      deepQuestion: 'How did DDD and service boundaries let Instant Ink scale from thousands to millions of subscribers?'
    },
    {
      teaser: 'Migration proof?',
      deepQuestion: 'Walk me through a migration you have led — what did it take?'
    },
    {
      teaser: 'Proof it worked?',
      deepQuestion: 'What proof convinced you it worked — metrics, audits, customer signals?'
    }
  ]
}

function normalizePoolEntry(entry) {
  if (entry && typeof entry === 'object' && typeof entry.teaser === 'string') {
    const teaser = entry.teaser.trim()
    const deepRaw = typeof entry.deepQuestion === 'string' ? entry.deepQuestion.trim() : ''
    const deepQuestion = deepRaw || teaser
    return { teaser, deepQuestion }
  }
  const s = String(entry || '').trim()
  return { teaser: s, deepQuestion: s }
}

let currentDeepQuestion = ''

function normalizeSlot(slot) {
  return slot === 'navbar' ? 'navbar' : 'hero'
}

/** Fraction of the measured hero launcher height that must sit below the fixed header and inside the viewport to keep `#agentNode` in `#agentSlotHero` (otherwise dock to navbar). */
const HERO_LAUNCHER_VISIBLE_FRAC = 0.36

export function initAgentNode(options = {}) {
  const node = document.getElementById('agentNode')
  const heroSlot = document.getElementById('agentSlotHero')
  const navbarSlot = document.getElementById('agentSlotNavbar')
  const mic = document.getElementById('agentNodeMic')
  const heroChatLabelWrap = heroSlot?.closest('.hero-chat')?.querySelector('.hero-chat__label-wrap')
  const form = node?.querySelector('.agent-node__form')
  const input = node?.querySelector('.agent-node__input')
  const ambientOverlay = node?.querySelector('.agent-node__ambient-overlay')

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
  let launcherObserver = null
  let homeDockScrollRaf = null
  let lastSyncedSection = 'home'
  const placeholderIdx = { home: 0, playground: 0, portfolio: 0 }
  let placeholderRotateTimer = null
  let placeholderCrossfadeTimer = null

  const prefersReducedMotion = () => Boolean(reducedMql?.matches)

  const isObstructingDialogOpen = () => (
    document.body.classList.contains('chat-dialog-open')
    || document.body.classList.contains('project-dialog-open')
    || document.body.classList.contains('contact-dialog-open')
  )

  const placeholderSubscribers = new Set()

  const getPlaceholderSuggestion = () => ({
    teaser: String(input.placeholder || '').trim(),
    deepQuestion: String(currentDeepQuestion || '').trim(),
    section: state.section
  })

  const notifyPlaceholderChange = () => {
    const payload = getPlaceholderSuggestion()
    placeholderSubscribers.forEach((fn) => {
      try {
        fn(payload)
      } catch (_) {
        // Ignore subscriber errors
      }
    })
  }

  const subscribePlaceholder = (fn) => {
    if (typeof fn !== 'function') return () => {}
    placeholderSubscribers.add(fn)
    fn(getPlaceholderSuggestion())
    return () => {
      placeholderSubscribers.delete(fn)
    }
  }

  const poolForSection = (section) => (
    PLACEHOLDER_POOL[section] || PLACEHOLDER_POOL.home
  )

  const clearPlaceholderCrossfade = () => {
    if (!placeholderCrossfadeTimer) return
    clearTimeout(placeholderCrossfadeTimer)
    placeholderCrossfadeTimer = null
  }

  const applyPlaceholder = (section, index, { animate = false } = {}) => {
    clearPlaceholderCrossfade()
    const pool = poolForSection(section)
    const n = Number(index) || 0
    const i = ((n % pool.length) + pool.length) % pool.length
    const entry = normalizePoolEntry(pool[i])

    let doAnimate = Boolean(animate) && !prefersReducedMotion()
    if (doAnimate && (isOpen() || node.matches(':focus-within'))) doAnimate = false
    if (doAnimate && String(input.value || '').trim()) doAnimate = false
    if (doAnimate && node.classList.contains('agent-node--lifecycle-active')) doAnimate = false

    if (!doAnimate) {
      input.placeholder = entry.teaser
      currentDeepQuestion = entry.deepQuestion
      input.style.removeProperty('opacity')
      input.style.removeProperty('transition')
      notifyPlaceholderChange()
      return
    }

    input.style.transition = `opacity ${PLACEHOLDER_CROSSFADE_MS}ms ease`
    input.style.opacity = '0'
    placeholderCrossfadeTimer = setTimeout(() => {
      placeholderCrossfadeTimer = null
      input.placeholder = entry.teaser
      currentDeepQuestion = entry.deepQuestion
      notifyPlaceholderChange()
      requestAnimationFrame(() => {
        void input.offsetWidth
        input.style.opacity = '1'
      })
      setTimeout(() => {
        input.style.removeProperty('transition')
      }, PLACEHOLDER_CROSSFADE_MS + 60)
    }, PLACEHOLDER_CROSSFADE_MS)
  }

  const bumpPlaceholderOnSectionChange = (section) => {
    const pool = poolForSection(section)
    placeholderIdx[section] = (placeholderIdx[section] + 1) % pool.length
  }

  const clearPlaceholderRotateTimer = () => {
    if (!placeholderRotateTimer) return
    clearInterval(placeholderRotateTimer)
    placeholderRotateTimer = null
  }

  const syncBubbleLifecycleOverlay = (busy) => {
    if (!ambientOverlay) return
    if (busy && state.mode === 'bubble') {
      ambientOverlay.style.opacity = '1'
      ambientOverlay.style.pointerEvents = 'none'
      input.style.setProperty('color', 'transparent')
      input.style.setProperty('-webkit-text-fill-color', 'transparent')
      input.style.setProperty('caret-color', 'transparent')
      return
    }
    ambientOverlay.style.removeProperty('opacity')
    ambientOverlay.style.removeProperty('pointer-events')
    input.style.removeProperty('color')
    input.style.removeProperty('-webkit-text-fill-color')
    input.style.removeProperty('caret-color')
  }

  const syncPlaceholderRotation = () => {
    clearPlaceholderRotateTimer()
    if (prefersReducedMotion() || isOpen()) return
    if (!isFinePointer()) return
    if (state.mode === 'modal') return
    // Always arm the interval when otherwise eligible. If a project/contact dialog
    // is open at navigation time, an early return here left no timer at all, so
    // rotation never resumed after the dialog closed (nothing re-called sync).
    placeholderRotateTimer = window.setInterval(() => {
      if (isOpen() || node.matches(':focus-within')) return
      if (isObstructingDialogOpen()) return
      if (state.mode === 'modal') return
      const sec = state.section
      placeholderIdx[sec] = (placeholderIdx[sec] + 1) % poolForSection(sec).length
      applyPlaceholder(sec, placeholderIdx[sec], { animate: true })
    }, PLACEHOLDER_ROTATE_MS)
  }

  const clearLeaveTimer = () => {
    if (!leaveTimer) return
    clearTimeout(leaveTimer)
    leaveTimer = null
  }

  const isFinePointer = () => Boolean(mql?.matches)

  const syncInputReadOnly = () => {
    if (isFinePointer() || state.mode === 'modal' || state.mode === 'bar') {
      input.readOnly = false
      return
    }
    input.readOnly = true
  }

  const refreshPlaceholderUi = () => {
    applyPlaceholder(state.section, placeholderIdx[state.section])
    syncInputReadOnly()
    syncPlaceholderRotation()
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

  const setState = (nextState = 'bubble') => {
    const prev = state.mode
    const safe = nextState === 'bar' || nextState === 'modal' ? nextState : 'bubble'
    state.mode = safe
    node.dataset.state = safe
    if (safe === 'modal') clearPlaceholderRotateTimer()
    syncInputReadOnly()
    options.onStateChange?.(safe)
    const after = () => {
      if (safe !== 'modal') syncPlaceholderRotation()
    }
    if (prev === 'modal' && safe === 'bubble') {
      requestAnimationFrame(after)
    } else {
      after()
    }
  }

  const dockTo = (nextSlot = 'hero') => {
    const safe = normalizeSlot(nextSlot)
    const parent = safe === 'navbar' ? navbarSlot : heroSlot
    if (node.parentElement !== parent) {
      parent.appendChild(node)
    }
    if (mic) {
      if (safe === 'hero' && heroChatLabelWrap) {
        heroChatLabelWrap.appendChild(mic)
      } else {
        node.appendChild(mic)
      }
    }
    state.slot = safe
    node.dataset.slot = safe
    options.onDockChange?.(safe)
    if (!isOpen()) {
      setState('bubble')
    } else {
      refreshPlaceholderUi()
    }
    spacemanPosition?.updatePosition?.()
  }

  const applyHomeDockFromHeroVisibility = () => {
    if (state.section !== 'home') return
    const want = state.heroVisible ? 'hero' : 'navbar'
    if (state.slot === want && node.parentElement === (want === 'navbar' ? navbarSlot : heroSlot)) {
      return
    }
    dockTo(want)
  }

  const readViewportYExtents = () => {
    const vv = window.visualViewport
    if (vv && Number.isFinite(vv.height) && vv.height > 0) {
      const top = Math.max(0, Number(vv.offsetTop) || 0)
      return { top, bottom: top + vv.height }
    }
    const bottom = window.innerHeight || document.documentElement.clientHeight || 0
    return { top: 0, bottom }
  }

  const readFixedHeaderBottom = () => {
    const header = document.body.querySelector('header')
    if (!header) return 0
    const br = header.getBoundingClientRect()
    return Number.isFinite(br.bottom) ? br.bottom : 0
  }

  /** Hero copy is “usable” only if enough of the pill (or reserved slot when docked away) sits in the visual viewport below the fixed header. */
  const readHeroLauncherAccessible = () => {
    if (!heroSlot) return true
    const inHeroSlot = node.parentElement === heroSlot
    const el = inHeroSlot ? node : heroSlot
    const r = el.getBoundingClientRect()
    const { top: vpTop, bottom: vpBottom } = readViewportYExtents()
    const usableTop = Math.min(Math.max(vpTop, readFixedHeaderBottom()), vpBottom)
    if (!Number.isFinite(r.height) || r.height < 4) return false
    const overlap = Math.max(0, Math.min(r.bottom, vpBottom) - Math.max(r.top, usableTop))
    return overlap / r.height >= HERO_LAUNCHER_VISIBLE_FRAC
  }

  const syncHeroVisibilityForDock = () => {
    state.heroVisible = readHeroLauncherAccessible()
  }

  const scheduleHomeDockFromScroll = () => {
    if (state.section !== 'home') return
    if (homeDockScrollRaf != null) return
    homeDockScrollRaf = requestAnimationFrame(() => {
      homeDockScrollRaf = null
      syncHeroVisibilityForDock()
      applyHomeDockFromHeroVisibility()
    })
  }

  const syncFromNavigation = (section = 'home') => {
    const next = normalizeSection(section)
    const sectionChanged = next !== lastSyncedSection
    if (sectionChanged) {
      bumpPlaceholderOnSectionChange(next)
      lastSyncedSection = next
    }
    state.section = next
    if (next === 'home') {
      syncHeroVisibilityForDock()
      dockTo(state.heroVisible ? 'hero' : 'navbar')
      requestAnimationFrame(() => {
        syncHeroVisibilityForDock()
        applyHomeDockFromHeroVisibility()
      })
    } else {
      dockTo('navbar')
    }
    applyPlaceholder(state.section, placeholderIdx[state.section], { animate: sectionChanged })
    if (
      isFinePointer()
      && !isOpen()
      && state.mode !== 'modal'
      && (node.matches(':hover') || node.matches(':focus-within'))
    ) {
      setState('bar')
    } else {
      syncPlaceholderRotation()
    }
  }

  const onPointerEnter = () => {
    if (!isFinePointer()) return
    clearLeaveTimer()
    if (state.mode !== 'modal') {
      setState('bar')
    }
  }

  const onFocusInAgent = () => {
    clearPlaceholderCrossfade()
    input.style.removeProperty('opacity')
    input.style.removeProperty('transition')
    onPointerEnter()
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

  const shouldOpenPanelFromLauncher = () => {
    if (isOpen()) return false
    if (state.mode === 'modal') return false
    if (String(input.value || '').trim()) return false
    if (isObstructingDialogOpen()) return false
    return state.mode === 'bubble' || state.mode === 'bar'
  }

  const isLauncherPanelPointerTarget = (target) => {
    if (!target || !form.contains(target)) return false
    if (target.closest('.agent-node__mic')) return false
    if (target.closest('.agent-node__submit')) return false
    return true
  }

  form.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== undefined) return
    if (event.target.closest('.agent-node__mic')) return
    if (event.target.closest('.agent-node__submit')) return
    if (!shouldOpenPanelFromLauncher()) return
    if (!isLauncherPanelPointerTarget(event.target)) return
    event.preventDefault()
    openPanel()
  }, true)

  const submitLauncher = () => {
    const text = String(input.value || '').trim()
    const source = state.slot === 'navbar' ? 'header' : 'hero'
    if (!text) {
      openPanel()
      return
    }
    input.value = ''
    openPanelWithMessage(text, source)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submitLauncher()
  })

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    submitLauncher()
  })

  input.addEventListener('focus', () => {
    if (isFinePointer() && state.mode !== 'modal') {
      setState('bar')
    }
  })

  node.addEventListener('click', (event) => {
    if (isFinePointer()) return
    if (state.mode !== 'bubble' || isOpen()) return
    if (event.target.closest('.agent-node__mic')) return
    if (event.target.closest('.agent-node__submit')) return
    if (event.target.closest('.agent-node__form')) return
    if (String(input.value || '').trim()) return
    openPanel()
  })

  node.addEventListener('focusin', onFocusInAgent)
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
    LIFECYCLE_STATES.forEach((status) => {
      const safe = status.replace(/_/g, '-')
      node.classList.remove(`agent-node--lifecycle-${safe}`)
    })
    const busy = Boolean(chatState && chatState !== 'idle')
    syncBubbleLifecycleOverlay(busy)
    if (!chatState || chatState === 'idle') return
    const safeState = String(chatState).replace(/_/g, '-')
    node.classList.add('agent-node--lifecycle-active', `agent-node--lifecycle-${safeState}`)
  }

  unsubscribeChatBus = chatBus.on((chatState) => {
    applyLifecycleClass(chatState)
  })

  const onFinePointerMqlChange = () => {
    if (!isFinePointer() && state.mode !== 'modal') {
      clearLeaveTimer()
      setState('bubble')
    } else {
      syncInputReadOnly()
      refreshPlaceholderUi()
    }
  }
  mql?.addEventListener?.('change', onFinePointerMqlChange)

  const onReducedMotionMqlChange = () => {
    clearPlaceholderRotateTimer()
    refreshPlaceholderUi()
  }
  reducedMql?.addEventListener?.('change', onReducedMotionMqlChange)

  const onScrollLikeForHomeDock = () => {
    scheduleHomeDockFromScroll()
  }

  if (typeof IntersectionObserver === 'function' && heroSlot) {
    launcherObserver?.disconnect()
    launcherObserver = new IntersectionObserver(() => {
      syncHeroVisibilityForDock()
      applyHomeDockFromHeroVisibility()
    }, {
      root: null,
      rootMargin: '0px',
      threshold: [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.65, 0.8, 1]
    })
    launcherObserver.observe(heroSlot)
  } else {
    syncHeroVisibilityForDock()
  }

  window.addEventListener('scroll', onScrollLikeForHomeDock, { passive: true })
  window.addEventListener('scrollend', onScrollLikeForHomeDock)
  window.visualViewport?.addEventListener?.('scroll', onScrollLikeForHomeDock)
  window.visualViewport?.addEventListener?.('resize', onScrollLikeForHomeDock)

  syncFromNavigation('home')

  const destroy = () => {
    clearLeaveTimer()
    clearPlaceholderRotateTimer()
    clearPlaceholderCrossfade()
    input.style.removeProperty('opacity')
    input.style.removeProperty('transition')
    syncBubbleLifecycleOverlay(false)
    if (homeDockScrollRaf != null) {
      cancelAnimationFrame(homeDockScrollRaf)
      homeDockScrollRaf = null
    }
    window.removeEventListener('scroll', onScrollLikeForHomeDock)
    window.removeEventListener('scrollend', onScrollLikeForHomeDock)
    window.visualViewport?.removeEventListener?.('scroll', onScrollLikeForHomeDock)
    window.visualViewport?.removeEventListener?.('resize', onScrollLikeForHomeDock)
    launcherObserver?.disconnect()
    launcherObserver = null
    unsubscribeChatBus?.()
    unsubscribeChatBus = null
    placeholderSubscribers.clear()
    mql?.removeEventListener?.('change', onFinePointerMqlChange)
    reducedMql?.removeEventListener?.('change', onReducedMotionMqlChange)
  }

  return {
    getSlot,
    getRect,
    setState,
    dockTo,
    syncFromNavigation,
    getPlaceholderSuggestion,
    subscribePlaceholder,
    destroy
  }
}
