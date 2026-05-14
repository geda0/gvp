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
    playgroundNav: document.getElementById('playgroundNav'),
    homeNav: document.getElementById('homeNav'),
    playgroundContent: document.getElementById('playgroundContent'),
    portfolioContent: document.getElementById('portfolioContent'),
    projects: document.getElementById('projects'),
    portfolioProjects: document.getElementById('portfolioProjects')
  }

  const navRequired = [
    'homeNav',
    'playgroundNav',
    'portfolioNav',
    'playgroundContent',
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
    if (nextSection === 'playground') {
      goPlay(elements, event)
    } else if (nextSection === 'portfolio') {
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
    if (hash === '#playground') {
      applySection('playground', null, true)
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

  elements.playgroundNav?.addEventListener('click', (e) => {
    e.preventDefault()
    history.replaceState(null, '', '#playground')
    applySection('playground', e, true)
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
  if (!el?.projects || !el?.portfolioProjects || !el?.playgroundContent || !el?.portfolioContent) return
  window.scrollTo({ top: 0, behavior: 'smooth' })
  el.projects.classList.remove('content-section-reveal')
  el.portfolioProjects.classList.remove('content-section-reveal')
  el.playgroundContent.classList.remove('visible')
  el.playgroundContent.classList.add('hidden')
  el.projects.classList.remove('visible')
  el.projects.classList.add('hidden')
  el.playgroundNav.classList.remove('section-invisible')
  el.portfolioNav.classList.remove('section-invisible')
  el.homeNav.classList.add('section-invisible')
  el.projects.classList.add('section-invisible')
  el.portfolioProjects.classList.remove('visible')
  el.portfolioProjects.classList.add('hidden')
  el.portfolioContent.classList.remove('visible')
  el.portfolioContent.classList.add('hidden')
  if (event) trackClick(event)
}

function goPlay(el, event) {
  if (!el?.projects || !el?.portfolioProjects || !el?.playgroundContent || !el?.portfolioContent) return
  window.scrollTo({ top: 0, behavior: 'smooth' })
  el.portfolioProjects.classList.remove('content-section-reveal')
  el.projects.classList.remove('content-section-reveal')
  el.portfolioContent.classList.remove('visible')
  el.portfolioContent.classList.add('hidden')
  el.portfolioProjects.classList.remove('visible')
  el.portfolioProjects.classList.add('hidden')

  el.playgroundContent.classList.remove('hidden')
  el.playgroundContent.classList.add('visible')
  el.playgroundNav.classList.add('section-invisible')
  el.portfolioNav.classList.remove('section-invisible')
  el.homeNav.classList.remove('section-invisible')

  el.projects.classList.remove('section-invisible')
  el.projects.classList.remove('hidden')
  el.projects.classList.add('visible', 'content-section-reveal')

  if (event) trackClick(event)
}

function goPortfolio(el, event) {
  if (!el?.projects || !el?.portfolioProjects || !el?.playgroundContent || !el?.portfolioContent) return
  window.scrollTo({ top: 0, behavior: 'smooth' })
  el.projects.classList.remove('content-section-reveal')
  el.portfolioProjects.classList.remove('content-section-reveal')
  el.playgroundContent.classList.remove('visible')
  el.playgroundContent.classList.add('hidden')
  el.projects.classList.remove('visible')
  el.projects.classList.add('hidden')

  el.portfolioContent.classList.remove('hidden')
  el.portfolioContent.classList.add('visible')
  el.portfolioNav.classList.add('section-invisible')
  el.homeNav.classList.remove('section-invisible')
  el.playgroundNav.classList.remove('section-invisible')

  el.portfolioProjects.classList.remove('section-invisible')
  el.portfolioProjects.classList.remove('hidden')
  el.portfolioProjects.classList.add('visible', 'content-section-reveal')

  if (event) trackClick(event)
}

export { state }
