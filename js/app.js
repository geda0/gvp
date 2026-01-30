// app.js - Main initialization
import { initAnalytics } from './analytics.js';
import { initNavigation } from './navigation.js';
import { initStarfield } from './starfield.js';
import { loadProjects, renderProjects } from './projects.js';
import { initSpaceman } from './spaceman.js';

// Global spaceman reference for navigation hooks
let spaceman = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize modules in order
  initAnalytics();
  initStarfield('canvas');

  // Initialize spaceman (replaces hero text)
  spaceman = initSpaceman('spacemanContainer', '/data/spaceman.json');

  // Initialize navigation with spaceman hook
  initNavigation({
    onStateChange: (state) => {
      if (spaceman) {
        spaceman.setState(state);
      }
    }
  });

  // Load and render project data
  const data = await loadProjects('/data/projects.json');
  renderProjects('playgroundContent', data.playground);
  renderProjects('portfolioContent', data.portfolio);
});

export { spaceman };
