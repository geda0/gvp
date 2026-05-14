import { chatBus } from './chat-bus.js'

const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const MORPH_LEAVE_DEBOUNCE_MS = 120
const PLACEHOLDER_ROTATE_MS = 4500
const LIFECYCLE_STATES = ['sending', 'thinking', 'streaming', 'tool_call', 'error']

const PLACEHOLDER_POOL = {
  home: [
    {
      teaser: 'Walk me through how you design platform boundaries.',
      deepQuestion: 'How do you approach platform architecture—interfaces, ownership boundaries, and operability—and what trade-offs showed up most clearly at HP Instant Ink or JumpCloud scale?'
    },
    {
      teaser: 'What outcome still feels worth the trade-offs?',
      deepQuestion: 'Tell me about an accomplishment you are especially proud of: the problem, your role, constraints, measurable impact if you can share it, and what you would refine with hindsight.'
    },
    {
      teaser: 'How do AI tools change your spec-to-ship loop?',
      deepQuestion: 'How do AI-assisted workflows (planning, documentation, coding in Cursor or similar) change how you deliver without lowering review quality, security, or accountability for production systems?'
    },
    {
      teaser: 'Pick one data-heavy system to unwind end-to-end.',
      deepQuestion: 'Choose a thread across your work on AWS, Kubernetes, Spark, EMR, or Databricks and walk through one pipeline or service end to end: inputs, failure modes, SLAs, and how you validated correctness under load.'
    }
  ],
  playground: [
    {
      teaser: 'Which experiment should we stress-test for trade-offs?',
      deepQuestion: 'Which playground project should we dissect first—what hypothesis did it test, what stack did you pick over alternatives, and what would you instrument or simplify on a second iteration?'
    },
    {
      teaser: 'Want problem framing, stack, or what you would try next?',
      deepQuestion: 'For the experiment you care about most here, restate the problem in one paragraph, summarize the architecture you shipped, and list the top three risks you would mitigate before promoting it beyond a demo.'
    },
    {
      teaser: 'How did you validate the idea without over-building?',
      deepQuestion: 'How did you validate this experiment quickly—spikes, metrics, user feedback, or operational signals—and where did you consciously defer polish to learn faster?'
    },
    {
      teaser: 'What integration boundary hurt most—and how did you fix it?',
      deepQuestion: 'What was the hardest integration boundary in this work (APIs, auth, data contracts, deployment), how did you isolate failures, and what pattern would you reuse on a larger team?'
    }
  ],
  portfolio: [
    {
      teaser: 'Which role should we go deep on first?',
      deepQuestion: 'Which portfolio position should we unpack in depth—scope, org context, and the one deliverable or initiative that best shows how you lead execution from design through stable operations?'
    },
    {
      teaser: 'Do you want scope, metrics, or team impact emphasized?',
      deepQuestion: 'For your strongest role here, separate scope (what you owned), metrics (outcomes you can share), and team impact (mentoring, bar-raising). Which lens matters most for the job you are targeting?'
    },
    {
      teaser: 'Unpack a deliverable you still stand behind years later.',
      deepQuestion: 'Pick one concrete deliverable from this role—migration, platform cutover, reliability push, or customer-facing launch—and walk through stakeholders, timeline pressure, and how you proved it was done safely.'
    },
    {
      teaser: 'How does this chapter connect to what you optimize for now?',
      deepQuestion: 'How does this portfolio chapter connect to the problems you optimize for today—identity, data platforms, SaaS scale, or leadership—and what skill from then do you still lean on every week?'
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
  const mic = document.getElementById('agentNodeMic')
  const heroChatLabelWrap = heroSlot?.closest('.hero-chat')?.querySelector('.hero-chat__label-wrap')
  const form = node?.querySelector('.agent-node__form')
  const input = node?.querySelector('.agent-node__input')
  const ambientOverlay = node?.querySelector('.agent-node__ambient-overlay')

  if (!node || !heroSlot || !navbarSlot || !form || !input) return null

  const {
    openPanelWithMessage = () => {},
    openPanelWithDraft = () => {},
    isOpen = () => false,
    spacemanPosition = null
  } = options

  const openLauncherDeepIntent = () => {
    const deep = String(currentDeepQuestion || '').trim()
    if (!deep) return
    const source = state.slot === 'navbar' ? 'header' : 'hero'
    openPanelWithDraft(deep, source, { intentPill: deep })
  }

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
  let lastSyncedSection = 'home'
  const placeholderIdx = { home: 0, playground: 0, portfolio: 0 }
  let placeholderRotateTimer = null

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
    const entry = normalizePoolEntry(pool[i])
    input.placeholder = entry.teaser
    currentDeepQuestion = entry.deepQuestion
  }

  const bumpPlaceholderOnSectionChange = (section) => {
    const pool = poolForSection(section)
    placeholderIdx[section] = (placeholderIdx[section] + 1) % pool.length
    applyPlaceholder(section, placeholderIdx[section])
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
    if (isObstructingDialogOpen()) return
    if (spacemanPosition?.isQuiet) return
    placeholderRotateTimer = window.setInterval(() => {
      if (isOpen() || node.matches(':focus-within')) return
      if (isObstructingDialogOpen()) return
      if (spacemanPosition?.isQuiet) return
      if (state.mode === 'modal') return
      const sec = state.section
      placeholderIdx[sec] = (placeholderIdx[sec] + 1) % poolForSection(sec).length
      applyPlaceholder(sec, placeholderIdx[sec])
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
    if (safe === 'modal') clearPlaceholderRotateTimer()
    syncTrailVisibility()
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
    applyPlaceholder(state.section, placeholderIdx[state.section])
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

  const shouldOpenDeepIntentFromLauncher = () => {
    if (isOpen()) return false
    if (state.mode === 'modal') return false
    if (String(input.value || '').trim()) return false
    if (node.classList.contains('agent-node--lifecycle-active')) return false
    if (isObstructingDialogOpen()) return false
    return state.mode === 'bubble' || state.mode === 'bar'
  }

  form.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== undefined) return
    if (event.target.closest('.agent-node__mic')) return
    if (!shouldOpenDeepIntentFromLauncher()) return
    const inLane = event.target.closest('.agent-node__text-lane')
      || event.target === input
    if (!inLane) return
    event.preventDefault()
    openLauncherDeepIntent()
  }, true)

  const submitLauncher = () => {
    const text = String(input.value || '').trim()
    const source = state.slot === 'navbar' ? 'header' : 'hero'
    if (!text) {
      openLauncherDeepIntent()
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
    if (event.target.closest('.agent-node__form')) return
    if (String(input.value || '').trim()) return
    openLauncherDeepIntent()
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
    const busy = Boolean(chatState && chatState !== 'idle')
    syncBubbleLifecycleOverlay(busy)
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
      refreshPlaceholderUi()
    }
  }
  mql?.addEventListener?.('change', onFinePointerMqlChange)

  const onReducedMotionMqlChange = () => {
    clearPlaceholderRotateTimer()
    refreshPlaceholderUi()
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

  syncFromNavigation('home')
  syncTrailVisibility()

  const destroy = () => {
    clearLeaveTimer()
    clearPlaceholderRotateTimer()
    syncBubbleLifecycleOverlay(false)
    launcherObserver?.disconnect()
    launcherObserver = null
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
