// theme-time.js — pure "time of day → theme" engine for the living continuum.
//
// One scalar (local wall-clock hours, 0–24) drives everything: the sky gradient,
// the canvas-scene weights (stars / sun / fireflies), and which existing chrome
// palette to apply (garden by day, space by night — so the UI colours reuse the
// two palettes already in styles.css; only the SKY + scene interpolate).
//
// Dependency-free and side-effect-free on purpose: all the math lives here so it
// is unit-tested in node:test (mirrors starfield-prefs.js). No DOM, no imports.

// Keyframes around the clock. `sky` = three gradient stops (top → horizon),
// `star`/`sun`/`firefly` = 0–1 scene weights. h must be ascending; midnight (0)
// is reused as the h=24 endpoint so the cycle wraps continuously.
const KEYFRAMES = [
  { h: 0, sky: ['#10131f', '#171d2c', '#222a40'], star: 1, sun: 0, firefly: 0.15 },
  { h: 5, sky: ['#10131f', '#171d2c', '#222a40'], star: 1, sun: 0, firefly: 0 },
  { h: 7, sky: ['#2a2150', '#8a5a6a', '#e0a85a'], star: 0.35, sun: 0.15, firefly: 0 },
  { h: 9, sky: ['#7eb0c8', '#a8cfae', '#4d7a58'], star: 0, sun: 0.6, firefly: 0 },
  { h: 12, sky: ['#86b8cf', '#b0d4b6', '#4d7a58'], star: 0, sun: 1, firefly: 0 },
  { h: 17, sky: ['#7eb0c8', '#a8cfae', '#4d7a58'], star: 0, sun: 0.55, firefly: 0 },
  { h: 19, sky: ['#160f2e', '#5b3358', '#3a6b48'], star: 0.4, sun: 0.12, firefly: 1 },
  { h: 21, sky: ['#10131f', '#171d2c', '#222a40'], star: 1, sun: 0, firefly: 0.35 },
]

// Virtual wrap endpoint: midnight again at h=24.
const WRAPPED = [...KEYFRAMES, { ...KEYFRAMES[0], h: 24 }]

/** Wrap any number into [0,24); non-finite input falls back to 0 (midnight). */
export function clampHours(h) {
  const n = Number(h)
  if (!Number.isFinite(n)) return 0
  return ((n % 24) + 24) % 24
}

/** Local wall-clock hours of a Date as a float (e.g. 9:30 → 9.5). */
export function hoursFromDate(date) {
  const d = date instanceof Date ? date : new Date()
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
}

function _lerp(a, b, t) {
  return a + (b - a) * t
}

function _hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex))
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

function _rgbToHex([r, g, b]) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function _lerpColor(a, b, t) {
  if (t <= 0) return String(a)
  if (t >= 1) return String(b)
  const ca = _hexToRgb(a)
  const cb = _hexToRgb(b)
  return _rgbToHex([_lerp(ca[0], cb[0], t), _lerp(ca[1], cb[1], t), _lerp(ca[2], cb[2], t)])
}

/** The two bracketing keyframes for an hour, plus the 0–1 position between them. */
function _segmentAt(hours) {
  const h = clampHours(hours)
  for (let i = 0; i < WRAPPED.length - 1; i++) {
    const a = WRAPPED[i]
    const b = WRAPPED[i + 1]
    if (h >= a.h && h <= b.h) {
      const span = b.h - a.h
      return { a, b, t: span === 0 ? 0 : (h - a.h) / span }
    }
  }
  return { a: WRAPPED[0], b: WRAPPED[1], t: 0 }
}

/** Scene weights at an hour: { star, sun, firefly }, each in [0,1]. */
export function sceneParamsAt(hours) {
  const { a, b, t } = _segmentAt(hours)
  return {
    star: _lerp(a.star, b.star, t),
    sun: _lerp(a.sun, b.sun, t),
    firefly: _lerp(a.firefly, b.firefly, t),
  }
}

/** The three interpolated sky gradient stops (top → horizon) at an hour. */
export function skyStopsAt(hours) {
  const { a, b, t } = _segmentAt(hours)
  return [
    _lerpColor(a.sky[0], b.sky[0], t),
    _lerpColor(a.sky[1], b.sky[1], t),
    _lerpColor(a.sky[2], b.sky[2], t),
  ]
}

/** A ready-to-use CSS background for --bg-primary at an hour. */
export function skyGradientAt(hours) {
  const [c0, c1, c2] = skyStopsAt(hours)
  return `linear-gradient(180deg, ${c0} 0%, ${c1} 50%, ${c2} 100%)`
}

/**
 * Which EXISTING chrome palette to apply at an hour: 'garden' (day) or 'space'
 * (night). Keyed off the scene so it follows brightness — daylight (sun ≥ star)
 * uses the garden chrome, otherwise the space chrome. Reusing the two palettes
 * already in styles.css avoids interpolating every UI variable.
 */
export function chromeThemeAt(hours) {
  const { sun, star } = sceneParamsAt(hours)
  return sun >= star ? 'garden' : 'space'
}

// ── Preference model ────────────────────────────────────────────────────────
// The living theme stores either 'time' (auto — follow the local clock) or
// 'time:<hours>' (a pinned hour from the slider). Anything else — legacy
// space/garden/studio/auto, empty, junk — resolves to auto so old visitors and
// fresh visitors both land in the live day/night world.

/** @returns {{auto: boolean, hours: number|null}} */
export function parseThemePref(stored) {
  const s = stored == null ? '' : String(stored)
  if (s === 'time') return { auto: true, hours: null }
  const m = /^time:(-?\d+(?:\.\d+)?)$/.exec(s)
  if (m) return { auto: false, hours: clampHours(parseFloat(m[1])) }
  return { auto: true, hours: null }
}

/** @param {{auto: boolean, hours: number|null}} pref */
export function serializeThemePref(pref) {
  if (pref && pref.auto === false && Number.isFinite(pref.hours)) {
    return `time:${clampHours(pref.hours)}`
  }
  return 'time'
}

/** The hour to render for a preference: pinned value, or the clock for auto. */
export function resolveThemeHours(pref, date) {
  if (pref && pref.auto === false && Number.isFinite(pref.hours)) {
    return clampHours(pref.hours)
  }
  return hoursFromDate(date instanceof Date ? date : new Date())
}
