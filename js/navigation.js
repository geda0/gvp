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
    labsNav: document.getElementById('labsNav'),
    homeNav: document.getElementById('homeNav'),
    portfolioContent: document.getElementById('portfolioContent'),
    portfolioProjects: document.getElementById('portfolioProjects'),
    labsContent: document.getElementById('labsContent'),
    labsProjects: document.getElementById('labsProjects')
  }

  const navRequired = [
    'homeNav',
    'portfolioNav',
    'labsNav',
    'portfolioContent',
    'portfolioProjects',
    'labsContent',
    'labsProjects'
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
    } else if (nextSection === 'labs') {
      goLabs(elements, event)
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
    if (hash === '#labs') {
      applySection('labs', null, true)
    } else if (hash === '#playground') {
      // Legacy '#playground' bookmarks now resolve to the Labs page.
      history.replaceState(null, '', '#labs')
      applySection('labs', null, true)
    } else if (hash === '#portfolio') {
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

  elements.labsNav?.addEventListener('click', (e) => {
    e.preventDefault()
    history.replaceState(null, '', '#labs')
    applySection('labs', e, true)
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

// Hide a top-level page container + its project grid.
function hidePage(content, projects) {
  if (projects) {
    projects.classList.remove('content-section-reveal', 'visible')
    projects.classList.add('section-invisible', 'hidden')
  }
  if (content) {
    content.classList.remove('visible')
    content.classList.add('hidden')
  }
}

// Reveal a top-level page container + its project grid (with the bloom reveal).
function showPage(content, projects) {
  if (content) {
    content.classList.remove('hidden')
    content.classList.add('visible')
  }
  if (projects) {
    projects.classList.remove('section-invisible', 'hidden')
    projects.classList.add('visible', 'content-section-reveal')
  }
}

// Show every nav link except the active section's own (you can't navigate to the
// page you're already on). Generalizes the old two-link toggle to three pages.
function setNavVisibility(el, active) {
  const toggle = (node, hidden) => node && node.classList.toggle('section-invisible', hidden)
  toggle(el.homeNav, active === 'home')
  toggle(el.portfolioNav, active === 'portfolio')
  toggle(el.labsNav, active === 'labs')
}

function goHome(el, event) {
  if (!el?.portfolioContent) return
  window.scrollTo({ top: 0, behavior: 'smooth' })
  hidePage(el.portfolioContent, el.portfolioProjects)
  hidePage(el.labsContent, el.labsProjects)
  setNavVisibility(el, 'home')
  if (event) trackClick(event)
}

function goPortfolio(el, event) {
  if (!el?.portfolioContent || !el?.portfolioProjects) return
  window.scrollTo({ top: 0, behavior: 'smooth' })
  showPage(el.portfolioContent, el.portfolioProjects)
  hidePage(el.labsContent, el.labsProjects)
  setNavVisibility(el, 'portfolio')
  if (event) trackClick(event)
}

function goLabs(el, event) {
  if (!el?.labsContent || !el?.labsProjects) return
  window.scrollTo({ top: 0, behavior: 'smooth' })
  showPage(el.labsContent, el.labsProjects)
  hidePage(el.portfolioContent, el.portfolioProjects)
  setNavVisibility(el, 'labs')
  if (event) trackClick(event)
}

export { state }
