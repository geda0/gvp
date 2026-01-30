// navigation.js - Navigation state management
import { trackClick } from './analytics.js';

const state = {
  activeTab: false
};

export function initNavigation() {
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

  elements.portfolioNav.addEventListener('click', (e) => {
    e.preventDefault();
    state.activeTab = true;
    goPortfolio(elements, e);
  });

  elements.playgroundNav.addEventListener('click', (e) => {
    e.preventDefault();
    state.activeTab = true;
    goPlay(elements, e);
  });

  elements.homeNav.addEventListener('click', (e) => {
    e.preventDefault();
    state.activeTab = false;
    goHome(elements, e);
  });
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
  trackClick(event);
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

  trackClick(event);
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

  trackClick(event);
}

export { state };
