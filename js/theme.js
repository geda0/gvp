// theme.js - Theme system (space | garden)
const STORAGE_KEY = 'gvp-theme';
const THEMES = ['space', 'garden'];

export function getTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (THEMES.includes(stored)) return stored;
  return 'space';
}

export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY, theme);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

export function initTheme() {
  const theme = getTheme();
  document.documentElement.setAttribute('data-theme', theme);
}
