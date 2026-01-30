// app.js - Main initialization
import { initAnalytics } from './analytics.js';
import { initNavigation } from './navigation.js';
import { initStarfield } from './starfield.js';
import { loadProjects, renderProjects } from './projects.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize modules in order
  initAnalytics();
  initStarfield('canvas');
  initNavigation();

  // Load and render project data
  const data = await loadProjects('/data/projects.json');
  renderProjects('playgroundContent', data.playground);
  renderProjects('portfolioContent', data.portfolio);
});
