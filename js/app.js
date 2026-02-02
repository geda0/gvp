// app.js - Main initialization
import { initAnalytics } from './analytics.js';
import { initNavigation } from './navigation.js';
import { initTheme, getTheme, transitionToTheme } from './theme.js';
import { initStarfield } from './starfield.js';
import { loadProjects, renderProjects } from './projects.js';
import { initSpaceman } from './spaceman.js';
import { initSpacemanPosition } from './spaceman-position.js';

// Global spaceman reference for navigation hooks
let spaceman = null;
let spacemanPosition = null;
let currentSection = 'home';

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize modules in order
  initAnalytics();
  initTheme();
  initStarfield('canvas', { getTheme });

  // Theme toggle
  const themeToggle = document.getElementById('themeToggle');
  const updateToggleLabel = () => {
    if (!themeToggle) return;
    const isSpace = getTheme() === 'space';
    const icon = isSpace ? '🦸' : '🚀';
    const text = isSpace ? 'Go to Land' : 'Go to Space';
    themeToggle.innerHTML = `<span class="theme-toggle-icon" aria-hidden="true">${icon}</span> ${text}`;
  };
  if (themeToggle) {
    updateToggleLabel();
    themeToggle.addEventListener('click', () => {
      transitionToTheme(getTheme() === 'space' ? 'garden' : 'space');
      // updateToggleLabel will be called on themechange event after transition completes
    });
  }
  window.addEventListener('themechange', updateToggleLabel);

  // Initialize spaceman (replaces hero text); await so DOM is ready before positioning
  spaceman = await initSpaceman('spacemanContainer', '/data/spaceman.json');
  const spacemanEl = document.getElementById('spaceman');
  if (spacemanEl) {
    spacemanPosition = initSpacemanPosition(spacemanEl);
    // Connect spaceman to position controller for quiet mode
    if (spaceman) {
      spaceman.setPositionController(spacemanPosition);
    }
  }

  // Initialize navigation with spaceman hook
  initNavigation({
    onStateChange: (state) => {
      currentSection = state;
      if (spaceman) {
        spaceman.setState(state);
        if (state !== 'playground' && state !== 'portfolio') {
          spaceman.setContext(null);
        }
      }
      if (spacemanPosition) {
        spacemanPosition.updatePosition();
      }
    }
  });

  // Load and render project data
  const data = await loadProjects('/data/projects.json');
  renderProjects('playgroundContent', data.playground);
  renderProjects('portfolioContent', data.portfolio);

  // Intersection Observer: set spaceman context to the project card most in view
  const projectCards = document.querySelectorAll('#playgroundContent .project, #portfolioContent .project');
  const ratios = new Map();
  const THRESHOLD = 0.1;

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
      updateVisibleProject();
    },
    { root: null, rootMargin: '0px', threshold: [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1] }
  );
  projectCards.forEach((card) => observer.observe(card));
});

export { spaceman, spacemanPosition };
