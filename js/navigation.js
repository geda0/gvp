// navigation.js - Navigation state management
import { trackClick } from './analytics.js';

const state = {
  activeTab: false
};

let callbacks = {
  onStateChange: null
};

export function initNavigation(options = {}) {
  callbacks = { ...callbacks, ...options };

  const elements = {
    portfolioNav: document.getElementById('portfolioNav'),
    playgroundNav: document.getElementById('playgroundNav'),
    homeNav: document.getElementById('homeNav'),
    contentWrapper: document.getElementById('contentWrapper'),
    playgroundContent: document.getElementById('playgroundContent'),
    portfolioContent: document.getElementById('portfolioContent'),
    projects: document.getElementById('projects'),
    portfolioProjects: document.getElementById('portfolioProjects')
  };

  function navigateByHash() {
    const hash = window.location.hash || '#home';
    if (hash === '#playground') {
      state.activeTab = true;
      goPlay(elements, null);
      callbacks.onStateChange?.('playground');
    } else if (hash === '#portfolio') {
      state.activeTab = true;
      goPortfolio(elements, null);
      callbacks.onStateChange?.('portfolio');
    } else {
      state.activeTab = false;
      goHome(elements, null);
      callbacks.onStateChange?.('home');
    }
  }

  elements.portfolioNav?.addEventListener('click', (e) => {
    e.preventDefault();
    state.activeTab = true;
    history.replaceState(null, '', '#portfolio');
    goPortfolio(elements, e);
    callbacks.onStateChange?.('portfolio');
  });

  elements.playgroundNav?.addEventListener('click', (e) => {
    e.preventDefault();
    state.activeTab = true;
    history.replaceState(null, '', '#playground');
    goPlay(elements, e);
    callbacks.onStateChange?.('playground');
  });

  elements.homeNav?.addEventListener('click', (e) => {
    e.preventDefault();
    state.activeTab = false;
    history.replaceState(null, '', '#home');
    goHome(elements, e);
    callbacks.onStateChange?.('home');
  });

  window.addEventListener('hashchange', navigateByHash);
  navigateByHash();
}

function goHome(el, event) {
  el.playgroundContent.classList.remove("visible");
  el.playgroundContent.classList.add("hidden");
  el.projects.classList.remove("visible");
  el.projects.classList.add("hidden");
  el.contentWrapper.style.transform = "translateY(20vh)";
  el.playgroundNav.classList.remove("section-invisible");
  el.portfolioNav.classList.remove("section-invisible");
  el.homeNav.classList.add("section-invisible");
  el.projects.classList.add("section-invisible");
  el.portfolioProjects.classList.remove("visible");
  el.portfolioProjects.classList.add("hidden");
  el.projects.classList.remove("visible");
  el.projects.classList.add("hidden");
  el.portfolioContent.classList.remove("visible");
  el.portfolioContent.classList.add("hidden");
  if (event) trackClick(event);
}

function goPlay(el, event) {
  el.portfolioContent.classList.remove("visible");
  el.portfolioContent.classList.add("hidden");
  el.portfolioProjects.classList.remove("visible");
  el.portfolioProjects.classList.add("hidden");

  el.playgroundContent.classList.remove("hidden");
  el.playgroundContent.classList.add("visible");
  el.playgroundNav.classList.add("section-invisible");
  el.portfolioNav.classList.remove("section-invisible");
  el.homeNav.classList.remove("section-invisible");
  el.contentWrapper.style.transform = "translateY(0)";

  setTimeout(() => {
    el.projects.classList.remove("section-invisible");
    el.projects.classList.remove("hidden");
    el.projects.classList.add("visible");
  }, 199);

  if (event) trackClick(event);
}

function goPortfolio(el, event) {
  el.playgroundContent.classList.remove("visible");
  el.playgroundContent.classList.add("hidden");
  el.projects.classList.remove("visible");
  el.projects.classList.add("hidden");

  el.portfolioContent.classList.remove("hidden");
  el.portfolioContent.classList.add("visible");
  el.portfolioNav.classList.add("section-invisible");
  el.homeNav.classList.remove("section-invisible");
  el.playgroundNav.classList.remove("section-invisible");
  el.contentWrapper.style.transform = "translateY(0)";

  setTimeout(() => {
    el.portfolioProjects.classList.remove("section-invisible");
    el.portfolioProjects.classList.remove("hidden");
    el.portfolioProjects.classList.add("visible");
  }, 199);

  if (event) trackClick(event);
}

export { state };
