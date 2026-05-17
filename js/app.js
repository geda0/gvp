// app.js - Main initialization
import './site-config.js'
import {
  initAnalytics,
  bindOutboundTracking,
  trackThemeChange
} from './analytics.js'
import { initNavigation } from './navigation.js'
import { initTheme, getTheme, transitionToTheme } from './theme.js'
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

  // Theme toggle — emoji; data-target + CSS set button background to the theme you switch *to*
  const themeToggle = document.getElementById('themeToggle')
  const updateToggleLabel = () => {
    if (!themeToggle) return;
    const target = getTheme() === 'space' ? 'garden' : 'space'
    themeToggle.dataset.target = target
    const isSpace = getTheme() === 'space'
    const icon = isSpace ? '🦸' : '🚀'
    let iconEl = themeToggle.querySelector('.theme-toggle-icon')
    if (!iconEl) {
      iconEl = document.createElement('span')
      iconEl.className = 'theme-toggle-icon'
      iconEl.setAttribute('aria-hidden', 'true')
      themeToggle.appendChild(iconEl)
    }
    iconEl.textContent = icon
    themeToggle.setAttribute(
      'aria-label',
      target === 'garden' ? 'Switch to Garden theme' : 'Switch to Space theme'
    )
  };
  if (themeToggle) {
    updateToggleLabel()
    themeToggle.addEventListener('click', () => {
      transitionToTheme(getTheme() === 'space' ? 'garden' : 'space')
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
