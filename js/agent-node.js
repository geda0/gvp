import { chatBus } from './chat-bus.js'
import { normalizeSection } from './section-names.js'

const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const MORPH_LEAVE_DEBOUNCE_MS = 120
const PLACEHOLDER_ROTATE_MS = 4500
const LIFECYCLE_STATES = ['sending', 'thinking', 'streaming', 'tool_call', 'error']

const PLACEHOLDER_POOL = {
  home: [
    {
      teaser: 'Ask about my Apptio work',
      deepQuestion: 'What did you work on at Apptio (IBM)? Walk me through the financial data pipelines, the problems you solved, and the impact you had.'
    },
    {
      teaser: 'What did a normal week look like at JumpCloud?',
      deepQuestion: 'What did a normal week look like at JumpCloud—systems you owned, stakeholders, metrics you watched, and how you prioritized when incidents stacked up?'
    },
    {
      teaser: 'How did you prove the pipeline migration was correct?',
      deepQuestion: 'When you sped up or migrated data pipelines at Apptio (IBM), how did you prove correctness under load—tests, reconciliation, shadow traffic—and what broke first when scale showed up?'
    },
    {
      teaser: "What's your AWS experience?",
      deepQuestion: 'Tell me about your hands-on AWS experience: which services you have used in production, the scale you operated at, and a system you are proud of.'
    },
    {
      teaser: 'What was your hardest project?',
      deepQuestion: 'What is the hardest project you have worked on? Describe the problem, the constraints, your role, and how you got it across the line.'
    },
    {
      teaser: 'Walk me through how you design platform boundaries.',
      deepQuestion: 'How do you approach platform architecture—interfaces, ownership boundaries, and operability—and what trade-offs showed up most clearly at HP Instant Ink or JumpCloud scale?'
    },
    {
      teaser: 'What outcome still feels worth the trade-offs?',
      deepQuestion: 'Tell me about an accomplishment you are especially proud of: the problem, your role, constraints, measurable impact if you can share it, and what you would refine with hindsight.'
    }
  ],
  playground: [
    {
      teaser: 'What is this project and why did you build it?',
      deepQuestion: 'What is this playground project, what problem or idea does it explore, and what did you set out to learn by building it?'
    },
    {
      teaser: 'In one sentence, what does this build do?',
      deepQuestion: 'In plain language: what does this playground build do for a user or team, what problem it solves, and what is intentionally out of scope?'
    },
    {
      teaser: 'What tech stack did you use here?',
      deepQuestion: 'What tech stack did you pick for this experiment, what alternatives did you consider, and why did you choose this one?'
    },
    {
      teaser: 'Which experiment should we stress-test for trade-offs?',
      deepQuestion: 'Which playground project should we dissect first—what hypothesis did it test, what stack did you pick over alternatives, and what would you instrument or simplify on a second iteration?'
    },
    {
      teaser: 'What integration boundary hurt most—and how did you fix it?',
      deepQuestion: 'What was the hardest integration boundary in this work (APIs, auth, data contracts, deployment), how did you isolate failures, and what pattern would you reuse on a larger team?'
    }
  ],
  portfolio: [
    {
      teaser: 'Tell me about this role',
      deepQuestion: 'Tell me about this role: what you owned, the org context, and the work that best shows how you operate.'
    },
    {
      teaser: 'Who did you work with most in this job?',
      deepQuestion: 'In this role, who did you work with day to day—engineering leadership, product, customers—and how did decisions get made when priorities conflicted?'
    },
    {
      teaser: 'What did you ship here?',
      deepQuestion: 'What is one concrete thing you shipped in this role—a migration, launch, or platform change—and how did you make sure it landed safely?'
    },
    {
      teaser: 'Which role should we go deep on first?',
      deepQuestion: 'Which portfolio position should we unpack in depth—scope, org context, and the one deliverable or initiative that best shows how you lead execution from design through stable operations?'
    },
    {
      teaser: 'Unpack a deliverable you still stand behind years later.',
      deepQuestion: 'Pick one concrete deliverable from this role—migration, platform cutover, reliability push, or customer-facing launch—and walk through stakeholders, timeline pressure, and how you proved it was done safely.'
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

const HERO_OBSERVER_THRESHOLDS = [0, 0.2, 0.35, 0.6, 1]

export function initAgentNode(options = {}) {
  const node = document.getElementById('agentNode')
  const heroSlot = document.getElementById('agentSlotHero')
  const navbarSlot = document.getElementById('agentSlotNavbar')
  const trail = document.getElementById('agentTrail')
  const mic = document.getElementById('agentNodeMic')
  const heroChatLabelWrap = heroSlot?.closest('.hero-chat')?.querySelector('.hero-chat__label-wrap')
  /** Match pre–agent-node behavior: observe the whole hero chat column, not only the pill slot. */
  const heroScrollDockRoot = heroSlot?.closest('.hero-chat') || heroSlot
  const form = node?.querySelector('.agent-node__form')
  const input = node?.querySelector('.agent-node__input')
  const ambientOverlay = node?.querySelector('.agent-node__ambient-overlay')

  if (!node || !heroSlot || !navbarSlot || !form || !input) return null

  const {
    openPanelWithMessage = () => {},
    isOpen = () => false,
    spacemanPosition = null
  } = options

  const openLauncherDeepIntent = () => {
    const deep = String(currentDeepQuestion || '').trim()
    if (!deep) return
    const source = state.slot === 'navbar' ? 'header' : 'hero'
    openPanelWithMessage(deep, source)
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

  const applyPlaceholder = (section, index) => {
    const pool = poolForSection(section)
    const n = Number(index) || 0
    const i = ((n % pool.length) + pool.length) % pool.length
    const entry = normalizePoolEntry(pool[i])
    input.placeholder = entry.teaser
    currentDeepQuestion = entry.deepQuestion
    notifyPlaceholderChange()
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
    placeholderRotateTimer = window.setInterval(() => {
      if (isOpen() || node.matches(':focus-within')) return
      if (isObstructingDialogOpen()) return
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
    const dialogOpen = document.body.classList.contains('chat-dialog-open')
      || document.body.classList.contains('project-dialog-open')
      || document.body.classList.contains('contact-dialog-open')
    const visible = state.mode !== 'modal' && !dialogOpen
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
    const r = heroScrollDockRoot.getBoundingClientRect()
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
    launcherObserver.observe(heroScrollDockRoot)
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
    syncTrailVisibility,
    openLauncherDeepIntent,
    getPlaceholderSuggestion,
    subscribePlaceholder,
    destroy
  }
}
