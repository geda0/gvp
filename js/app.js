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

  // #region agent log
  requestAnimationFrame(() => {
    const body = document.body;
    const html = document.documentElement;
    const gardenScene = document.getElementById('gardenScene');
    const loadEl = document.getElementById('load');
    const contentWrapper = document.getElementById('contentWrapper');
    const mainEl = document.querySelector('main');
    const getStyle = (el, prop) => el ? (window.getComputedStyle(el).getPropertyValue(prop) || '').trim() : '';
    const rect = (el) => el ? el.getBoundingClientRect() : null;
    const payload = (hypothesisId, message, data) => ({
      location: 'app.js:background-rca',
      message,
      data: data || {},
      timestamp: Date.now(),
      sessionId: 'debug-session',
      hypothesisId
    });
    const ingest = (p) => fetch('http://127.0.0.1:7242/ingest/0f00c563-5dea-4262-9a10-26c8cc19e822', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).catch(() => {});
    ingest(payload('H1', 'Body viewport coverage', { dataTheme: html.getAttribute('data-theme'), bodyRect: rect(body), innerHeight: window.innerHeight, bodyBg: getStyle(body, 'background'), bodyBgImage: getStyle(body, 'background-image').slice(0, 80) }));
    ingest(payload('H2', 'Elements above body', { loadBg: getStyle(loadEl, 'background'), contentWrapperBg: getStyle(contentWrapper, 'background'), mainBg: getStyle(mainEl, 'background') }));
    ingest(payload('H3', 'garden-scene coverage', { sceneRect: rect(gardenScene), sceneDisplay: getStyle(gardenScene, 'display'), scenePosition: getStyle(gardenScene, 'position') }));
    ingest(payload('H4', 'Body background position/size', { bodyBgPosition: getStyle(body, 'background-position'), bodyBgSize: getStyle(body, 'background-size'), bodyBgOrigin: getStyle(body, 'background-origin') }));
    ingest(payload('H5', 'html background', { htmlBg: getStyle(html, 'background'), htmlBgImage: getStyle(html, 'background-image').slice(0, 80) }));
  });
  // #endregion

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
