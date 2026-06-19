// app.js - Main initialization
import './site-config.js'
import {
  initAnalytics,
  bindOutboundTracking,
  trackThemeChange
} from './analytics.js'
import { initSiteEvents } from './site-events.js'
import { initNavigation } from './navigation.js'
import { initTheme, getTheme, getThemeState, setAutoTime, setPinnedTime } from './theme.js'
import { initStarfield } from './starfield.js'
import {
  loadProjects,
  renderProjects,
  renderProjectsSectionError,
  showProjectsLoadSiteBanner,
  initProjectDetailDialog
} from './projects.js'
import { initSpaceman } from './spaceman.js'
import { initSpacemanPosition } from './spaceman-position.js'
import { initContactForm } from './contact.js'
import { initSpacemanProjectContext } from './spaceman-project-context.js'
import { initChat, collapseChatDialog, syncChatLaunchers, EV_OPEN_CHAT } from './chat.js'
import { initAgentNode } from './agent-node.js'
import { timeControlMode, timeTriggerLabel, TIME_TRIGGER_ICON_HTML } from './time-switcher-mode.js'

// Global spaceman reference for navigation hooks
let spaceman = null
let spacemanPosition = null
let currentSection = 'home'

document.addEventListener('DOMContentLoaded', async () => {
  initAnalytics()
  initSiteEvents()
  bindOutboundTracking()
  initTheme()
  initStarfield('canvas', { getTheme })
  initContactForm()

  // Living time-of-day slider — A native range input drives the hour (drag + keyboard);
  // Auto re-engages the local clock.
  const timeSlider = document.getElementById('timeSlider')
  const timeAutoBtn = document.getElementById('timeAuto')
  const timeIcon = document.getElementById('timeIcon')

  const syncTimeUi = () => {
    const st = getThemeState()
    if (timeSlider && document.activeElement !== timeSlider) {
      timeSlider.value = String(st.hours)
    }
    if (timeAutoBtn) timeAutoBtn.setAttribute('aria-pressed', String(st.auto))
    if (timeIcon) timeIcon.textContent = getTheme() === 'garden' ? '☀️' : '🌙'
  }

  timeSlider?.addEventListener('input', () => {
    setPinnedTime(parseFloat(timeSlider.value))
  })
  timeAutoBtn?.addEventListener('click', () => {
    setAutoTime()
    timeSlider?.focus?.()
  })

  window.addEventListener('themechange', (event) => {
    syncTimeUi()
    syncTriggerLabel()
    trackThemeChange(event?.detail?.theme || getTheme())
  })
  syncTimeUi()

  // ── Time-control responsive popover ────────────────────────────────────────
  // On tight viewports (≤767px) the inline slider collapses into a compact
  // trigger button (#timeTrigger) + popover (#timePanel). On desktop the trigger
  // is CSS-hidden and the panel stays inline — no JS needed for that path.
  // Mirrors the theme-menu a11y contract above (aria-expanded, hidden, Escape,
  // outside-click, focus-restore). Uses the pure seams from time-switcher-mode.js.
  const timeTriggerBtn = document.getElementById('timeTrigger')
  const timePanel = document.getElementById('timePanel')
  const mobileQuery = window.matchMedia('(max-width: 767px)')

  let timePanelOpen = false

  const isDropdownMode = () => timeControlMode(window.innerWidth) === 'dropdown'

  const positionTimePanel = () => {
    if (!timeTriggerBtn || !timePanel) return
    const rect = timeTriggerBtn.getBoundingClientRect()
    const margin = 8
    const panelWidth = timePanel.offsetWidth || 220
    let left = rect.left
    if (left + panelWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - panelWidth - margin)
    }
    timePanel.style.setProperty('--time-panel-x', `${Math.round(left)}px`)
    timePanel.style.setProperty('--time-panel-y', `${Math.round(rect.bottom + 6)}px`)
  }

  const syncTriggerLabel = () => {
    if (!timeTriggerBtn) return
    timeTriggerBtn.setAttribute('aria-label', timeTriggerLabel({ open: timePanelOpen }))
    timeTriggerBtn.setAttribute('aria-expanded', String(timePanelOpen))
    let iconEl = timeTriggerBtn.querySelector('.time-trigger__icon')
    if (!iconEl) {
      iconEl = document.createElement('span')
      iconEl.className = 'time-trigger__icon theme-toggle-icon--svg'
      iconEl.setAttribute('aria-hidden', 'true')
      timeTriggerBtn.replaceChildren(iconEl)
    }
    iconEl.innerHTML = TIME_TRIGGER_ICON_HTML
  }

  const openTimePanel = () => {
    if (!timeTriggerBtn || !timePanel) return
    timePanelOpen = true
    timePanel.hidden = false
    positionTimePanel()
    syncTriggerLabel()
    // Focus the slider so the user can immediately drag
    timeSlider?.focus?.()
  }

  const closeTimePanel = (restoreFocus) => {
    if (!timeTriggerBtn || !timePanel) return
    timePanelOpen = false
    timePanel.hidden = true
    syncTriggerLabel()
    if (restoreFocus) timeTriggerBtn.focus()
  }

  if (timeTriggerBtn && timePanel) {
    // On mobile the panel starts closed (hidden). On desktop CSS keeps it visible
    // and we never touch hidden (the panel has no hidden attr in markup).
    // Only manage hidden when in dropdown mode.
    if (isDropdownMode()) {
      timePanel.hidden = true
    }

    syncTriggerLabel()

    timeTriggerBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!isDropdownMode()) return
      if (timePanelOpen) closeTimePanel(false)
      else openTimePanel()
    })

    timeTriggerBtn.addEventListener('keydown', (e) => {
      if (!isDropdownMode()) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (timePanelOpen) closeTimePanel(false)
        else openTimePanel()
      } else if (e.key === 'ArrowDown' && !timePanelOpen) {
        e.preventDefault()
        openTimePanel()
      }
    })

    timePanel.addEventListener('keydown', (e) => {
      if (!isDropdownMode()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeTimePanel(true)
      }
    })

    // Close popover only when focus truly leaves the panel (Tab-out lands naturally)
    timePanel.addEventListener('focusout', (e) => {
      if (!isDropdownMode() || !timePanelOpen) return
      const next = e.relatedTarget
      // Keep open if focus stays inside the panel or moves back to the trigger
      if (next && (timePanel.contains(next) || next === timeTriggerBtn)) return
      closeTimePanel(false)
    })

    document.addEventListener('click', (e) => {
      if (!isDropdownMode() || !timePanelOpen) return
      if (timeTriggerBtn.contains(e.target) || timePanel.contains(e.target)) return
      closeTimePanel(false)
    })

    // Reposition on viewport changes while panel is open
    const repositionIfOpen = () => { if (timePanelOpen && isDropdownMode()) positionTimePanel() }
    window.addEventListener('resize', repositionIfOpen)
    window.addEventListener('scroll', repositionIfOpen, { passive: true })

    // On resize across the breakpoint: restore panel visibility to the correct state
    mobileQuery.addEventListener('change', (e) => {
      if (e.matches) {
        // Switched to mobile: close and hide panel
        timePanelOpen = false
        timePanel.hidden = true
        syncTriggerLabel()
      } else {
        // Switched to desktop: ensure panel is visible (remove hidden)
        timePanelOpen = false
        timePanel.hidden = false
        syncTriggerLabel()
      }
    })
  }

  // Initialize spaceman (replaces hero text); await so DOM is ready before positioning
  spaceman = await initSpaceman('spacemanContainer', '/data/spaceman.json')
  const spacemanEl = document.getElementById('spaceman')
  if (spacemanEl) {
    spacemanPosition = initSpacemanPosition(spacemanEl)
    // Connect spaceman to position controller (drag, stay, layout)
    if (spaceman) {
      spaceman.setPositionController(spacemanPosition)
    }
  }

  const chatApi = initChat()
  if (chatApi) {
    const agentNodeApi = initAgentNode({
      openPanel: () => chatApi.openPanel(),
      openPanelWithMessage: (text, source, options) => chatApi.openPanelWithMessage(text, source, options),
      isOpen: () => chatApi.isOpen(),
      spacemanPosition,
      onStateChange: () => spacemanPosition?.updatePosition?.(),
      onDockChange: () => spacemanPosition?.updatePosition?.()
    })
    chatApi.bindAgentNode(agentNodeApi)
  }

  document.getElementById('footerOpenChatBtn')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent(EV_OPEN_CHAT))
  })

  // Initialize navigation with spaceman hook (after chat so first navigateByHash sync runs real impl)
  initNavigation({
    onStateChange: (state) => {
      currentSection = state
      if (spaceman) {
        spaceman.setState(state)
        if (state !== 'portfolio' && state !== 'labs') {
          spaceman.setContext(null)
        }
      }
      if (spacemanPosition) {
        spacemanPosition.updatePosition()
      }
      if (state === 'portfolio' || state === 'labs') {
        collapseChatDialog()
      }
      syncChatLaunchers(state)
    }
  })

  // Load and render project data. Portfolio (professional) renders into
  // #portfolioContent; Labs (personal builds, internally still `playground`)
  // renders into its own top-level page #labsContent.
  const data = await loadProjects('/data/projects.json')
  if (data.loadFailed) {
    showProjectsLoadSiteBanner()
    renderProjectsSectionError('portfolioContent')
    renderProjectsSectionError('labsContent')
  } else {
    renderProjects('portfolioContent', data.portfolio, 'portfolioProjects')
    renderProjects('labsContent', data.playground, 'labsProjects')
  }
  initProjectDetailDialog()

  initSpacemanProjectContext({
    getCurrentSection: () => currentSection,
    spaceman,
    spacemanPosition
  })

  // On mobile, pin garden scene to visual viewport so it doesn't shift when URL bar hides after first scroll
  const gardenScene = document.getElementById('gardenScene')
  const vv = window.visualViewport
  const mobileViewportMql = window.matchMedia('(max-width: 767px)')
  const isGarden = () => getTheme() === 'garden'

  // Cache last-applied values so scroll events that don't change anything
  // (most of them, once the URL bar settles) skip the style writes entirely.
  let lastVvTop = NaN
  let lastVvLeft = NaN
  let lastVvWidth = NaN
  let lastVvHeight = NaN
  let vvSyncRafId = 0

  function applyVisualViewportSync() {
    vvSyncRafId = 0
    if (!gardenScene || !vv || !mobileViewportMql.matches || !isGarden()) {
      if (gardenScene && !mobileViewportMql.matches) {
        gardenScene.style.top = ''
        gardenScene.style.left = ''
        gardenScene.style.width = ''
        gardenScene.style.height = ''
        lastVvTop = lastVvLeft = lastVvWidth = lastVvHeight = NaN
      }
      return
    }
    const top = vv.offsetTop
    const left = vv.offsetLeft
    const width = vv.width
    const height = vv.height
    if (top === lastVvTop && left === lastVvLeft && width === lastVvWidth && height === lastVvHeight) {
      return
    }
    lastVvTop = top
    lastVvLeft = left
    lastVvWidth = width
    lastVvHeight = height
    gardenScene.style.top = `${top}px`
    gardenScene.style.left = `${left}px`
    gardenScene.style.width = `${width}px`
    gardenScene.style.height = `${height}px`
  }

  function syncGardenSceneToVisualViewport() {
    if (vvSyncRafId) return
    vvSyncRafId = window.requestAnimationFrame(applyVisualViewportSync)
  }

  if (gardenScene && vv) {
    applyVisualViewportSync()
    vv.addEventListener('resize', syncGardenSceneToVisualViewport)
    vv.addEventListener('scroll', syncGardenSceneToVisualViewport, { passive: true })
    window.addEventListener('resize', syncGardenSceneToVisualViewport)
    window.addEventListener('themechange', syncGardenSceneToVisualViewport)
  }
})

export { spaceman, spacemanPosition }
