// Wires project-card IntersectionObserver + project dialog events to spaceman context.
import { trackProjectInteraction } from './analytics.js'
import {
  initProjectObserver,
  PROJECT_CARD_INTERSECTION_THRESHOLD_STEPS,
  PROJECT_CARD_MIN_VISIBLE_INTERSECTION_RATIO
} from './project-observer.js'

export {
  PROJECT_CARD_INTERSECTION_THRESHOLD_STEPS,
  PROJECT_CARD_MIN_VISIBLE_INTERSECTION_RATIO
}

export function initSpacemanProjectContext({
  getCurrentSection,
  spaceman,
  spacemanPosition
}) {
  const projectCards = document.querySelectorAll('#playgroundContent .project, #portfolioContent .project')
  const projectObserver = initProjectObserver(projectCards, {
    getCurrentSection,
    onVisibleChange: (card) => {
      if (!spaceman) return
      if (!card) {
        spaceman.setContext(null)
        return
      }
      spaceman.setContext({
        projectId: card.getAttribute('data-project-id') || '',
        projectTitle: card.getAttribute('data-project-title') || '',
        projectDescription: card.getAttribute('data-project-description') || ''
      })
    }
  })

  window.addEventListener('projectdialogopen', (e) => {
    const d = e.detail
    trackProjectInteraction('open_dialog', d?.projectId || '', getCurrentSection())
    if (spaceman && d) {
      spaceman.setDetermined(true)
      spaceman.setContext({
        projectId: d.projectId || '',
        projectTitle: d.title || '',
        projectDescription: d.projectDescription || ''
      })
      spaceman.announceProjectContext()
    }
    spacemanPosition?.updatePosition?.()
  })
  window.addEventListener('projectdialogclose', () => {
    trackProjectInteraction('close_dialog', '', getCurrentSection())
    spacemanPosition?.updatePosition?.()
    projectObserver.recompute()
    spaceman?.setDetermined(false)
  })

  return { projectObserver }
}
