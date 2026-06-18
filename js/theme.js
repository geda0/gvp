// theme.js — living "time of day" theme. One local-clock hour (or a pinned hour
// from the slider) drives an interpolated sky gradient + the garden/space chrome
// palette (reused from styles.css). All the math is in theme-time.js (pure +
// unit-tested); this module is the thin DOM/state layer.
import {
  skyGradientAt,
  chromeThemeAt,
  sceneParamsAt,
  parseThemePref,
  serializeThemePref,
  resolveThemeHours,
  hoursFromDate,
  clampHours,
} from './theme-time.js';

const STORAGE_KEY = 'gvp-theme';
const AUTO_TICK_MS = 60000; // re-sample the clock once a minute in auto mode

let currentHours = 12;
let autoTimer = null;

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

function readPref() {
  return parseThemePref(readStored());
}

function writePref(pref) {
  try {
    localStorage.setItem(STORAGE_KEY, serializeThemePref(pref));
  } catch (_) {
    /* private mode / storage off — runtime still works, just no persistence */
  }
}

/** Slider state for the UI: { auto, hours }. */
export function getThemeState() {
  const pref = readPref();
  return { auto: pref.auto, hours: resolveThemeHours(pref) };
}

/**
 * Chrome palette ('garden' | 'space') for the current hour. Kept so the existing
 * callers that branch on a discrete theme (spaceman.js, starfield.js) keep
 * working — daylight uses the garden palette, night uses space.
 */
export function getTheme() {
  return chromeThemeAt(currentHours);
}

/** Back-compat preference label for any old caller. */
export function getThemePreference() {
  return readPref().auto ? 'auto' : 'pinned';
}

/** Paint the world at a given hour: interpolated sky + chrome + scene marker. */
export function applyThemeTime(hours) {
  currentHours = clampHours(hours);
  const root = document.documentElement;
  const chrome = chromeThemeAt(currentHours);
  root.setAttribute('data-time', '');
  root.setAttribute('data-theme', chrome);
  root.dataset.timeHours = String(Math.round(currentHours * 100) / 100);
  root.style.setProperty('--time-sky', skyGradientAt(currentHours));
  // Garden scene (trees / ocean) lingers into dawn + dusk, gone deep at night.
  root.style.setProperty('--garden-opacity', String(sceneParamsAt(currentHours).ground));
  window.dispatchEvent(
    new CustomEvent('themechange', { detail: { theme: chrome, hours: currentHours } })
  );
}

function stopAutoTick() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

function startAutoTick() {
  stopAutoTick();
  autoTimer = setInterval(() => applyThemeTime(hoursFromDate(new Date())), AUTO_TICK_MS);
}

/** Follow the visitor's local clock (the default). */
export function setAutoTime() {
  writePref({ auto: true, hours: null });
  applyThemeTime(hoursFromDate(new Date()));
  startAutoTick();
}

/** Pin a specific hour (the slider was dragged). */
export function setPinnedTime(hours) {
  stopAutoTick();
  const h = clampHours(hours);
  writePref({ auto: false, hours: h });
  applyThemeTime(h);
}

export function initTheme() {
  const pref = readPref();
  applyThemeTime(resolveThemeHours(pref));
  if (pref.auto) startAutoTick();
}

// ── Back-compat no-op shims (the old multi-theme menu API; its callers are
//    being replaced by the slider). Kept so stale imports never throw. ──
export function setTheme() {}
export function setThemePreference() {}
export function transitionToTheme() {}
export function transitionToPreference() {}
