// app.js - Main initialization
import {
  initAnalytics,
  bindOutboundTracking,
  trackProjectInteraction,
  trackThemeChange
} from './analytics.js'
import { initNavigation } from './navigation.js'
import { initTheme, getTheme, transitionToTheme } from './theme.js'
import { initStarfield } from './starfield.js'
import {
  loadProjects,
  renderProjects,
  renderProjectsSectionError,
  initProjectDetailDialog
} from './projects.js'
import { initSpaceman } from './spaceman.js'
import { initSpacemanPosition } from './spaceman-position.js'
import { initContactForm } from './contact.js'
import { initChat, collapseChatDialog, syncHeroChatSurface } from './chat.js'

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
    // Connect spaceman to position controller for quiet mode
    if (spaceman) {
      spaceman.setPositionController(spacemanPosition)
    }
  }

  initChat()

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
      syncHeroChatSurface(state)
    }
  })

  // Load and render project data
  const data = await loadProjects('/data/projects.json')
  if (data.loadFailed) {
    renderProjectsSectionError('playgroundContent')
    renderProjectsSectionError('portfolioContent')
  } else {
    renderProjects('playgroundContent', data.playground)
    renderProjects('portfolioContent', data.portfolio)
  }
  initProjectDetailDialog()

  // Intersection Observer: set spaceman context to the project card most in view
  const projectCards = document.querySelectorAll('#playgroundContent .project, #portfolioContent .project')
  const ratios = new Map()
  const THRESHOLD = 0.1
  let visibleProjectRaf = 0

  function updateVisibleProject() {
    if (!spaceman) return;
    let best = { ratio: 0, card: null };
    ratios.forEach((ratio, card) => {
      if (ratio > best.ratio) {
        const section = card.closest('#playgroundContent') ? 'playground' : card.closest('#portfolioContent') ? 'portfolio' : null;
        if (section === currentSection) best = { ratio, card };
      }
    });
    if (best.ratio < THRESHOLD || !best.card) {
      spaceman.setContext(null);
      return;
    }
    const c = best.card;
    spaceman.setContext({
      projectId: c.getAttribute('data-project-id') || '',
      projectTitle: c.getAttribute('data-project-title') || '',
      projectDescription: c.getAttribute('data-project-description') || ''
    });
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        ratios.set(entry.target, entry.intersectionRatio);
      });
      if (!visibleProjectRaf) {
        visibleProjectRaf = requestAnimationFrame(() => {
          visibleProjectRaf = 0;
          updateVisibleProject();
        });
      }
    },
    { root: null, rootMargin: '0px', threshold: [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1] }
  );
  projectCards.forEach((card) => observer.observe(card));

  window.addEventListener('projectdialogopen', (e) => {
    const d = e.detail
    trackProjectInteraction('open_dialog', d?.projectId || '', currentSection)
    if (spaceman && d) {
      spaceman.setDetermined(true)
      spaceman.setContext({
        projectId: d.projectId || '',
        projectTitle: d.title || '',
        projectDescription: d.projectDescription || ''
      })
      spaceman.announceProjectContext()
    }
    spacemanPosition?.updatePosition()
  })
  window.addEventListener('projectdialogclose', () => {
    trackProjectInteraction('close_dialog', '', currentSection)
    spacemanPosition?.updatePosition()
    updateVisibleProject()
    // Resume hero messaging only after context is refreshed (so messages match section/home).
    spaceman?.setDetermined(false)
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
