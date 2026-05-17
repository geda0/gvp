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

  // Theme switcher — dropdown with all four prefs. Trigger button shows the
  // current theme; menu lets the user pick any of them or "Auto" (system).
  const themeToggle = document.getElementById('themeToggle')
  const themeMenu = document.getElementById('themeMenu')
  const PREF_ORDER = ['space', 'garden', 'studio', 'auto']
  /** Horizontal light/dark split — reads as “follow system appearance”. */
  const AUTO_ICON_HTML =
    '<svg class="theme-icon theme-icon--auto" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
    '<path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>'
  const PREF_META = {
    space:  { icon: '🚀', label: 'Space',  desc: 'Deep ink + nebula' },
    garden: { icon: '🦸', label: 'Garden', desc: 'Sky, trees, snow'  },
    studio: { icon: '📜', label: 'Studio', desc: 'Paper, low distraction' },
    auto:   { iconHtml: AUTO_ICON_HTML, label: 'Auto', desc: 'Match system' }
  }
  let menuOpen = false

  const setExpanded = (open) => {
    menuOpen = open
    themeToggle?.setAttribute('aria-expanded', String(open))
    if (!themeMenu) return
    themeMenu.hidden = !open
    themeToggle?.classList.toggle('theme-toggle--open', open)
  }

  const buildMenu = () => {
    if (!themeMenu) return
    themeMenu.innerHTML = ''
    const title = document.createElement('li')
    title.className = 'theme-menu__title'
    title.id = 'themeMenuTitle'
    title.setAttribute('role', 'presentation')
    title.textContent = 'Change theme'
    themeMenu.appendChild(title)
    themeMenu.setAttribute('aria-labelledby', 'themeMenuTitle')
    for (const pref of PREF_ORDER) {
      const meta = PREF_META[pref]
      const item = document.createElement('li')
      item.className = 'theme-menu__item'
      item.setAttribute('role', 'menuitemradio')
      item.dataset.pref = pref
      item.tabIndex = -1
      const iconMarkup = meta.iconHtml
        ? `<span class="theme-menu__icon theme-menu__icon--svg" aria-hidden="true">${meta.iconHtml}</span>`
        : `<span class="theme-menu__icon" aria-hidden="true">${meta.icon}</span>`
      item.innerHTML = `
        <span class="theme-menu__swatch theme-menu__swatch--${pref}" aria-hidden="true"></span>
        <span class="theme-menu__text">
          <span class="theme-menu__label">${iconMarkup}${meta.label}</span>
          <span class="theme-menu__desc">${meta.desc}</span>
        </span>
        <span class="theme-menu__check" aria-hidden="true">✓</span>
      `
      item.addEventListener('click', () => {
        transitionToPreference(pref)
        closeMenu(true)
      })
      themeMenu.appendChild(item)
    }
  }

  const syncMenuSelection = () => {
    if (!themeMenu || !themeToggle) return
    const pref = getThemePreference()
    const resolved = getTheme()
    themeToggle.dataset.current = resolved
    themeToggle.dataset.pref = pref
    const meta = PREF_META[pref]
    let iconEl = themeToggle.querySelector('.theme-toggle-icon')
    if (!iconEl) {
      iconEl = document.createElement('span')
      iconEl.className = 'theme-toggle-icon'
      iconEl.setAttribute('aria-hidden', 'true')
      themeToggle.appendChild(iconEl)
    }
    if (meta.iconHtml) {
      iconEl.innerHTML = meta.iconHtml
      iconEl.classList.add('theme-toggle-icon--svg')
    } else {
      iconEl.textContent = meta.icon
      iconEl.classList.remove('theme-toggle-icon--svg')
    }
    const labelText = pref === 'auto'
      ? `Theme: Auto (${resolved}) — change theme`
      : `Theme: ${meta.label} — change theme`
    themeToggle.setAttribute('aria-label', labelText)
    themeToggle.setAttribute('title', labelText)
    themeMenu.querySelectorAll('.theme-menu__item').forEach((el) => {
      const checked = el.dataset.pref === pref
      el.setAttribute('aria-checked', String(checked))
      el.classList.toggle('theme-menu__item--checked', checked)
    })
  }

  const menuItems = () =>
    Array.from(themeMenu?.querySelectorAll('.theme-menu__item') || [])

  const focusItem = (index) => {
    const items = menuItems()
    if (!items.length) return
    const idx = (index + items.length) % items.length
    items[idx].focus()
  }

  const positionMenu = () => {
    if (!themeToggle || !themeMenu) return
    const rect = themeToggle.getBoundingClientRect()
    // Anchor under the trigger. Keep 8px margin from viewport edges.
    const margin = 8
    const menuWidth = themeMenu.offsetWidth || 200
    let left = rect.left
    if (left + menuWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - menuWidth - margin)
    }
    themeMenu.style.setProperty('--theme-menu-x', `${Math.round(left)}px`)
    themeMenu.style.setProperty('--theme-menu-y', `${Math.round(rect.bottom + 6)}px`)
  }

  const openMenu = () => {
    setExpanded(true)
    positionMenu()
    // Focus the currently-selected item, or the first
    const items = menuItems()
    const currentIdx = items.findIndex((el) => el.dataset.pref === getThemePreference())
    focusItem(currentIdx >= 0 ? currentIdx : 0)
  }

  const closeMenu = (restoreFocus) => {
    setExpanded(false)
    if (restoreFocus) themeToggle?.focus()
  }

  if (themeToggle && themeMenu) {
    buildMenu()
    syncMenuSelection()

    themeToggle.addEventListener('click', (e) => {
      e.stopPropagation()
      if (menuOpen) closeMenu(false); else openMenu()
    })

    themeMenu.addEventListener('keydown', (e) => {
      const items = menuItems()
      const idx = items.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(idx + 1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(idx - 1) }
      else if (e.key === 'Home') { e.preventDefault(); focusItem(0) }
      else if (e.key === 'End') { e.preventDefault(); focusItem(items.length - 1) }
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        document.activeElement?.click?.()
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault()
        closeMenu(true)
      }
    })

    themeToggle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (!menuOpen) openMenu()
      }
    })

    document.addEventListener('click', (e) => {
      if (!menuOpen) return
      if (themeToggle.contains(e.target) || themeMenu.contains(e.target)) return
      closeMenu(false)
    })

    // Reposition on viewport changes while the menu is open.
    const repositionIfOpen = () => { if (menuOpen) positionMenu() }
    window.addEventListener('resize', repositionIfOpen)
    window.addEventListener('scroll', repositionIfOpen, { passive: true })
  }
  window.addEventListener('themechange', (event) => {
    syncMenuSelection()
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
