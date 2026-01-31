// app.js - Main initialization
import { initAnalytics } from './analytics.js';
import { initNavigation } from './navigation.js';
import { initTheme, getTheme, setTheme } from './theme.js';
import { initStarfield } from './starfield.js';
import { loadProjects, renderProjects } from './projects.js';
import { initSpaceman } from './spaceman.js';
import { initSpacemanPosition } from './spaceman-position.js';

// Global spaceman reference for navigation hooks
let spaceman = null;
let spacemanPosition = null;

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
    const text = isSpace ? 'Switch to Garden' : 'Switch to Space';
    themeToggle.innerHTML = `<span class="theme-toggle-icon" aria-hidden="true">${icon}</span> ${text}`;
  };
  if (themeToggle) {
    updateToggleLabel();
    themeToggle.addEventListener('click', () => {
      setTheme(getTheme() === 'space' ? 'garden' : 'space');
      updateToggleLabel();
    });
  }
  window.addEventListener('themechange', updateToggleLabel);

  // Initialize spaceman (replaces hero text)
  spaceman = initSpaceman('spacemanContainer', '/data/spaceman.json');

  // Wait for spaceman to render, then init positioning
  setTimeout(() => {
    const spacemanEl = document.getElementById('spaceman');
    if (spacemanEl) {
      spacemanPosition = initSpacemanPosition(spacemanEl);
    }
  }, 100);

  // Initialize navigation with spaceman hook
  initNavigation({
    onStateChange: (state) => {
      if (spaceman) {
        spaceman.setState(state);
      }
      // Position update is debounced internally - no need for extra timeout
      if (spacemanPosition) {
        spacemanPosition.updatePosition();
      }
    }
  });

  // Load and render project data
  const data = await loadProjects('/data/projects.json');
  renderProjects('playgroundContent', data.playground);
  renderProjects('portfolioContent', data.portfolio);
});

export { spaceman, spacemanPosition };
