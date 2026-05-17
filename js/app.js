// app.js - Main initialization
import './site-config.js'
import {
  initAnalytics,
  bindOutboundTracking,
  trackThemeChange
} from './analytics.js'
import { initNavigation } from './navigation.js'
import { initTheme, getTheme, getThemePreference, transitionToPreference } from './theme.js'
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

// Global spaceman reference for navigation hooks
let spaceman = null
let spacemanPosition = null
let currentSection = 'home'

document.addEventListener('DOMContentLoaded', async () => {
  initAnalytics()
  bindOutboundTracking()
  initTheme()
  initStarfield('canvas', { getTheme })
  initContactForm()

  // Theme toggle — cycles through prefs: garden → studio → space → auto → garden.
  // data-target / icon / aria-label always describe the NEXT preference (what a click switches to).
  const themeToggle = document.getElementById('themeToggle')
  const PREF_CYCLE = ['space', 'garden', 'studio', 'auto']
  const PREF_META = {
    garden:  { icon: '🦸', label: 'Switch to Garden theme' },
    studio:  { icon: '📜', label: 'Switch to Studio (paper) theme' },
    space:   { icon: '🚀', label: 'Switch to Space theme' },
    auto:    { icon: '🌓', label: 'Match system theme automatically' }
  }
  const nextPref = (current) => {
    const idx = PREF_CYCLE.indexOf(current)
    return PREF_CYCLE[(idx + 1) % PREF_CYCLE.length]
  }
  const updateToggleLabel = () => {
    if (!themeToggle) return;
    const target = nextPref(getThemePreference())
    const meta = PREF_META[target]
    themeToggle.dataset.target = target
    let iconEl = themeToggle.querySelector('.theme-toggle-icon')
    if (!iconEl) {
      iconEl = document.createElement('span')
      iconEl.className = 'theme-toggle-icon'
      iconEl.setAttribute('aria-hidden', 'true')
      themeToggle.appendChild(iconEl)
    }
    iconEl.textContent = meta.icon
    themeToggle.setAttribute('aria-label', meta.label)
    themeToggle.setAttribute('title', meta.label)
  };
  if (themeToggle) {
    updateToggleLabel()
    themeToggle.addEventListener('click', () => {
      transitionToPreference(nextPref(getThemePreference()))
    })
  }
  window.addEventListener('themechange', (event) => {
    updateToggleLabel()
    trackThemeChange(event?.detail?.theme || getTheme())
  })

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
        if (state !== 'playground' && state !== 'portfolio') {
          spaceman.setContext(null)
        }
      }
      if (spacemanPosition) {
        spacemanPosition.updatePosition()
      }
      if (state === 'playground' || state === 'portfolio') {
        collapseChatDialog()
      }
      syncChatLaunchers(state)
    }
  })

  // Load and render project data
  const data = await loadProjects('/data/projects.json')
  if (data.loadFailed) {
    showProjectsLoadSiteBanner()
    renderProjectsSectionError('playgroundContent')
    renderProjectsSectionError('portfolioContent')
  } else {
    renderProjects('playgroundContent', data.playground, 'projects')
    renderProjects('playgroundContent', data.playgroundBeta, 'playgroundBeta')
    renderProjects('portfolioContent', data.portfolio, 'portfolioProjects')
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

  function syncGardenSceneToVisualViewport() {
    if (!gardenScene || !vv || !mobileViewportMql.matches || !isGarden()) {
      if (gardenScene && !mobileViewportMql.matches) {
        gardenScene.style.top = '';
        gardenScene.style.left = '';
        gardenScene.style.width = '';
        gardenScene.style.height = '';
      }
      return;
    }
    gardenScene.style.top = `${vv.offsetTop}px`;
    gardenScene.style.left = `${vv.offsetLeft}px`;
    gardenScene.style.width = `${vv.width}px`;
    gardenScene.style.height = `${vv.height}px`;
  }

  if (gardenScene && vv) {
    syncGardenSceneToVisualViewport();
    vv.addEventListener('resize', syncGardenSceneToVisualViewport);
    vv.addEventListener('scroll', syncGardenSceneToVisualViewport);
    window.addEventListener('resize', syncGardenSceneToVisualViewport);
    window.addEventListener('themechange', syncGardenSceneToVisualViewport);
  }
})

export { spaceman, spacemanPosition }
