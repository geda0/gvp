// navigation.js - Navigation state management
import { trackClick, trackNavigation, trackVirtualPageView } from './analytics.js'
import { resolveNavTarget } from './section-names.js'
import { setSection } from './site-state.js'

const state = {
  activeTab: false,
  section: 'home'
}

let callbacks = {
  onStateChange: null
}

// Set during initNavigation so requestNavigation can reach the router's closures. Same
// pattern js/contact.js already uses for openContactDialog.
let requestNavigationImpl = null

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

  function applySection(nextSection, event = null, shouldTrack = true, origin = 'visitor') {
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
    // The store is written BEFORE the callback, so anything the callback triggers already
    // reads the settled state. origin is mandatory (ADR-0015 ss3.3): 'system' at boot,
    // 'agent' when a tool call asked, 'visitor' for everything the person did.
    setSection(nextSection, { origin })
    callbacks.onStateChange?.(nextSection)
    if (shouldTrack) {
      trackVirtualPageView(nextSection)
      if (previousSection !== nextSection) {
        trackNavigation(nextSection, previousSection)
      }
    }
  }

  function navigateByHash(origin = 'visitor') {
    const hash = window.location.hash
    if (hash === '#labs') {
      applySection('labs', null, true, origin)
    } else if (hash === '#playground') {
      // Legacy '#playground' bookmarks now resolve to the Labs page.
      history.replaceState(null, '', '#labs')
      applySection('labs', null, true, origin)
    } else if (hash === '#portfolio') {
      applySection('portfolio', null, true, origin)
    } else {
      applySection('home', null, true, origin)
    }
  }

  // Move the page on someone else's behalf - today the chat assistant's navigate_to_section
  // tool. It lives HERE, in the router, for two reasons ADR-0015 found the hard way:
  //  - js/chat.js used to drive the URL itself, and assigning the fragment the document
  //    already has dispatches no hashchange (HTML spec), so navigateByHash never ran while
  //    the tool still reported `navigated`. From inside the router that case is just "we are
  //    already there", which is TRUE and needs no event at all (ss9.4).
  //  - the write has to carry the right origin, and only the caller knows it. A hashchange
  //    cannot say who caused it.
  requestNavigationImpl = (raw, opts = {}) => {
    const target = resolveNavTarget(raw)
    if (target.error) return target
    const origin = opts.origin || 'visitor'
    if (target.id === 'home') {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    } else if (window.location.hash !== target.hash) {
      history.replaceState(null, '', target.hash)
    }
    // applySection directly, never through a synthesised hashchange: the router is right
    // here, and a same-value write is already a no-op in the store (ss3.4).
    applySection(target.id, null, true, origin)
    return target
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

  window.addEventListener('hashchange', () => navigateByHash('visitor'))
  // One boot read of the URL: neither the visitor nor the agent did anything (ss3.3).
  navigateByHash('system')
}

/**
 * Ask the router to move the page. Returns resolveNavTarget's result: `{ id, hash }` on
 * success, `{ error: 'unknown_section', received }` when the section does not exist.
 */
export function requestNavigation(raw, opts = {}) {
  if (!requestNavigationImpl) return { error: 'unknown_section', received: raw }
  return requestNavigationImpl(raw, opts)
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
