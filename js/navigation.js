// navigation.js - Navigation state management
import { trackClick, trackNavigation, trackVirtualPageView } from './analytics.js'

const state = {
  activeTab: false,
  section: 'home'
}

let callbacks = {
  onStateChange: null
}

export function initNavigation(options = {}) {
  callbacks = { ...callbacks, ...options }

  const elements = {
    portfolioNav: document.getElementById('portfolioNav'),
    homeNav: document.getElementById('homeNav'),
    portfolioContent: document.getElementById('portfolioContent'),
    projects: document.getElementById('projects'),
    portfolioProjects: document.getElementById('portfolioProjects')
  }

  const navRequired = [
    'homeNav',
    'portfolioNav',
    'portfolioContent',
    'projects',
    'portfolioProjects'
  ]
  if (navRequired.some((key) => !elements[key])) {
    console.warn('initNavigation: missing required DOM nodes; hash navigation disabled')
    return
  }

  function applySection(nextSection, event = null, shouldTrack = true) {
    const previousSection = state.section
    state.activeTab = nextSection !== 'home'
    state.section = nextSection
    document.body.classList.toggle('content-open', nextSection !== 'home')
    document.body.dataset.section = nextSection
    if (nextSection === 'portfolio') {
      goPortfolio(elements, event)
    } else {
      goHome(elements, event)
    }
    callbacks.onStateChange?.(nextSection)
    if (shouldTrack) {
      trackVirtualPageView(nextSection)
      if (previousSection !== nextSection) {
        trackNavigation(nextSection, previousSection)
      }
    }
  }

  function navigateByHash() {
    const hash = window.location.hash
    // Treat legacy '#playground' bookmarks as portfolio so old links keep working.
    if (hash === '#portfolio' || hash === '#playground') {
      applySection('portfolio', null, true)
    } else {
      applySection('home', null, true)
    }
  }

  elements.portfolioNav?.addEventListener('click', (e) => {
    e.preventDefault()
    history.replaceState(null, '', '#portfolio')
    applySection('portfolio', e, true)
  })

  elements.homeNav?.addEventListener('click', (e) => {
    e.preventDefault()
    // Home is the base URL (no hash)
    history.replaceState(null, '', window.location.pathname + window.location.search)
    applySection('home', e, true)
  })

  window.addEventListener('hashchange', navigateByHash)
  navigateByHash()
}

function goHome(el, event) {
  if (!el?.projects || !el?.portfolioProjects || !el?.portfolioContent) return
  window.scrollTo({ top: 0, behavior: 'smooth' })
  el.projects.classList.remove('content-section-reveal')
  el.portfolioProjects.classList.remove('content-section-reveal')
  el.projects.classList.remove('visible')
  el.projects.classList.add('hidden')
  el.portfolioNav.classList.remove('section-invisible')
  el.homeNav.classList.add('section-invisible')
  el.projects.classList.add('section-invisible')
  el.portfolioProjects.classList.remove('visible')
  el.portfolioProjects.classList.add('hidden')
  el.portfolioContent.classList.remove('visible')
  el.portfolioContent.classList.add('hidden')
  if (event) trackClick(event)
}

function goPortfolio(el, event) {
  if (!el?.projects || !el?.portfolioProjects || !el?.portfolioContent) return
  window.scrollTo({ top: 0, behavior: 'smooth' })

  el.portfolioContent.classList.remove('hidden')
  el.portfolioContent.classList.add('visible')
  el.portfolioNav.classList.add('section-invisible')
  el.homeNav.classList.remove('section-invisible')

  el.portfolioProjects.classList.remove('section-invisible', 'hidden')
  el.portfolioProjects.classList.add('visible', 'content-section-reveal')

  // Playground subsection lives inside the portfolio page now — reveal it too.
  el.projects.classList.remove('section-invisible', 'hidden')
  el.projects.classList.add('visible', 'content-section-reveal')

  if (event) trackClick(event)
}

export { state }
