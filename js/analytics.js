// analytics.js - Google Analytics wrapper
const GA_MEASUREMENT_ID = 'G-EYTRKC93DL'

function hasGtag() {
  return typeof window !== 'undefined' && typeof window.gtag === 'function'
}

export function initAnalytics() {
  window.dataLayer = window.dataLayer || []
  function gtag() {
    dataLayer.push(arguments)
  }
  gtag('js', new Date())
  gtag('config', GA_MEASUREMENT_ID, { send_page_view: false })
  window.gtag = gtag
}

export function trackEvent(eventName, params = {}) {
  if (!hasGtag() || !eventName) return
  window.gtag('event', eventName, {
    transport_type: 'beacon',
    ...params
  })
}

export function trackVirtualPageView(section, pagePath) {
  if (!hasGtag()) return
  const path = pagePath || (section === 'home' ? '/' : `/${section}`)
  window.gtag('event', 'page_view', {
    page_title: `gvp_${section}`,
    page_path: path,
    page_location: `${window.location.origin}${path}`,
    section
  })
}

export function trackNavigation(section, originSection) {
  trackEvent('section_navigation', {
    section,
    origin_section: originSection || 'unknown'
  })
}

export function trackThemeChange(theme) {
  trackEvent('theme_change', { theme })
}

export function trackProjectInteraction(action, projectId, section) {
  trackEvent('project_interaction', {
    interaction_type: action,
    project_id: projectId || 'unknown',
    section: section || 'unknown'
  })
}

export function trackClick(event) {
  const href = event?.target?.href || ''
  if (!href) return
  trackEvent('click', {
    event_category: 'Link Click',
    event_label: href
  })
}

export function trackOutboundClick(eventName, href) {
  trackEvent(eventName, {
    event_category: 'Outbound',
    event_label: href
  })
}

export function bindOutboundTracking() {
  document.querySelectorAll('[data-track]').forEach((el) => {
    el.addEventListener('click', () => {
      const name = el.getAttribute('data-track')
      const href = el.href || el.getAttribute('href') || ''
      trackOutboundClick(name, href)
    })
  })
}
