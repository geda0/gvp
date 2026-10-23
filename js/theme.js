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
import { precipitationFor } from './precipitation.js'

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

/** Paint the world at a given hour: interpolated sky + chrome + scene marker. */
/**
 * The visitor's IANA zone, or '' when the browser cannot say.
 *
 * Resolved HERE and injected, so js/precipitation.js never touches `Intl` and stays a pure
 * function of its arguments - the same trick as ADR-0015 §4.2's `ctx.wide`. It also means
 * the test suite cannot go red because of the host's locale data: a Node build without full
 * ICU answers 'UTC', which this module tolerates and the leaf treats as northern.
 */
function resolveTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (_) {
    return '';
  }
}

export function applyThemeTime(hours) {
  currentHours = clampHours(hours);
  const root = document.documentElement;
  const chrome = chromeThemeAt(currentHours);
  root.setAttribute('data-time', '');
  root.setAttribute('data-theme', chrome);
  root.dataset.timeHours = String(Math.round(currentHours * 100) / 100);
  root.style.setProperty('--time-sky', skyGradientAt(currentHours));
  // WHAT FALLS FROM THE SKY (ADR-0016 §3.2). The decision lives in js/precipitation.js and
  // the answer travels as one root attribute, exactly as the hour above already does -
  // js/starfield.js reads `dataset.precipitation` per frame the same way it reads
  // `dataset.timeHours`. This is that pattern, not a new one.
  //
  // HERE AND NOT IN THE RENDERER, and the reason is measured rather than architectural
  // taste: scripts/qa/starfield-ab-draws.mjs pins `Date.now`, and `new Date()` does NOT
  // consult it. A calendar read inside starfield.js would be invisible to that pin, and the
  // harness would start giving different answers depending on what day you ran it. This
  // module already calls `new Date()` and already owns the clock.
  //
  // WRITTEN ONLY WHEN IT CHANGES: applyThemeTime runs at boot, once a minute on the auto
  // tick, and on EVERY slider input event - an unconditional write would thrash the DOM
  // through a drag for a value that changes at most once a day.
  const timeZone = resolveTimeZone();
  const kind = precipitationFor(new Date(), { timeZone }).kind;
  if (root.dataset.precipitation !== kind) root.dataset.precipitation = kind;
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
