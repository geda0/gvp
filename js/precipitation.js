/**
 * What falls from the daytime sky, and why (ADR-0016 §2). The DECISION leaf.
 *
 * Today the daytime theme has snow and only snow — in July, in Sydney, everywhere. This
 * module decides; `js/starfield.js` only obeys, and a source fence keeps it that way (§3.3).
 *
 * PURE AND TOTAL, and both for the same reason. The renderer runs on
 * `requestAnimationFrame`: an exception in the decision path does not produce a wrong
 * colour, it stops the animation loop for the rest of the session. So nothing here throws —
 * invariant #12's posture, clamp and never throw — and nothing here reads `Intl`,
 * `window` or the clock. The timezone is injected, the same trick as ADR-0015 §4.2's
 * `ctx.wide`, which also means the test suite cannot go red because of the host's locale
 * data (a Node build without full ICU answers `'UTC'`).
 *
 * THIS MODULE ANSWERS *WHAT*. `starfield-prefs.js` answers *how much* and `theme-time.js`
 * answers *how bright*. Three questions, three owners, no overlap — which is why the
 * descriptor below carries no counts, speeds or colours.
 */

export const PRECIPITATION_KINDS = Object.freeze(['snow', 'rain', 'hail'])
export const SEASONS = Object.freeze(['winter', 'spring', 'summer', 'autumn'])
export const SHOULDER_SEASONS = Object.freeze(['spring', 'autumn'])
export const HAIL_ONE_IN = 9

/**
 * Unseasonal at worst, never absurd, and plausible in nine months of twelve.
 * NOT snow: snow in July is the bug this milestone exists to fix, so a fallback of snow
 * would make the bug survive its own fix in the one case nobody tests. NOT nothing: a blank
 * daytime sky is indistinguishable from a dead renderer.
 */
export const FALLBACK_KIND = 'rain'

/** Meteorological (WMO) boundaries, indexed by local month. Exact, and `getMonth()` is all it needs. */
const NORTHERN_BY_MONTH = Object.freeze([
  'winter', 'winter', 'spring', 'spring', 'spring', 'summer',
  'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'
])

/**
 * Southern IANA zones. An allowlist, because the alternative — `getTimezoneOffset()` — is a
 * LONGITUDE fact: Sydney and Vladivostok share an offset and are in opposite hemispheres.
 */
const SOUTHERN_ZONES = new Set([
  'America/Sao_Paulo', 'America/Santiago', 'America/Montevideo', 'America/Asuncion',
  'America/La_Paz', 'America/Lima', 'America/Punta_Arenas',
  'Africa/Johannesburg', 'Africa/Windhoek', 'Africa/Gaborone', 'Africa/Harare',
  'Africa/Lusaka', 'Africa/Maputo', 'Africa/Maseru', 'Africa/Mbabane', 'Africa/Luanda',
  'Indian/Antananarivo', 'Africa/Antananarivo',
  'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Fiji', 'Pacific/Port_Moresby',
  'Pacific/Noumea', 'Pacific/Tongatapu', 'Pacific/Apia', 'Pacific/Norfolk'
])
const SOUTHERN_PREFIXES = ['Australia/', 'Antarctica/', 'America/Argentina/']

const isDate = (value) => value instanceof Date && !Number.isNaN(value.getTime())

/**
 * @param {unknown} timeZone an IANA zone id, or anything at all
 * @returns {'north' | 'south'}
 */
export function hemisphereFor (timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return 'north'
  if (SOUTHERN_ZONES.has(timeZone)) return 'south'
  if (SOUTHERN_PREFIXES.some((p) => timeZone.startsWith(p))) return 'south'
  // NO 'unknown'. The two populations that produce it are opposites: a browser with no Intl
  // is overwhelmingly northern (that is where the browsers are), and a zone missing from
  // this list is probably somewhere the list does not need. Guessing the majority and
  // REPORTING THE GUESS in the descriptor beats telling both of them "no season".
  //
  // Equatorial zones are a named residual: Singapore and Nairobi get snow in December here,
  // which is wrong — and less wrong than today, where they get snow in all twelve months.
  // Additive when wanted: this returns 'tropic' and the kind table gains one row.
  return 'north'
}

/** The LOCAL calendar triple as one integer: `y*10000 + (m+1)*100 + d`. */
export function dayKeyFor (date) {
  if (!isDate(date)) return 0
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
}

/**
 * @param {Date} date
 * @param {'north' | 'south'} [hemisphere]
 * @returns {'winter' | 'spring' | 'summer' | 'autumn'}
 */
export function seasonFor (date, hemisphere) {
  if (!isDate(date)) return 'spring'
  // The LOCAL month, matching the clock the sky already uses (`theme-time.js` reads
  // getHours()). A UTC month would flip December→January at a different instant from the
  // midnight the sky wraps at.
  const month = date.getMonth()
  // One table plus one rotation, not two tables. Two tables is 24 facts that can disagree;
  // this makes a southern typo structurally impossible rather than merely untested.
  const index = hemisphere === 'south' ? (month + 6) % 12 : month
  return NORTHERN_BY_MONTH[index]
}

/** splitmix32's finaliser. The constants are pinned so a later tidy-up cannot re-roll everyone's calendar. */
function mix32 (value) {
  let x = value >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/**
 * Does this local calendar day win the hail lottery? One day in nine.
 *
 * THE LOTTERY, NOT THE FORECAST: this returns true on a January day where it will in fact
 * snow. `precipitationFor` is its only caller and is where the season gates it — folding
 * the season in here would duplicate `seasonFor` in two functions and make the distribution
 * untestable in isolation, since you would have to hunt for nine consecutive shoulder-season
 * days to probe a 1-in-9 rate.
 *
 * A HASH, NOT `dayKey % 9`, and that is arithmetic rather than taste: `10000 ≡ 1` and
 * `100 ≡ 1 (mod 9)`, so `dayKey % 9 ≡ (y + m + d) % 9` and consecutive days increment the
 * residue by one — hail on exactly every ninth day, forever, learnable in a month. The rate
 * is right and the lattice is visible, so only a gap-structure test tells them apart.
 *
 * NOT `Math.random()`: it re-rolls on every call (and `applyThemeTime` runs at boot, once a
 * minute, and on every slider drag — the weather would strobe), two tabs would disagree, it
 * is untestable in a repo with no mocking library, and any new consumer of the global RNG
 * stream in the render path shifts every subsequent star and poisons the render-identity
 * harness.
 */
export function isHailDay (date) {
  if (!isDate(date)) return false
  return mix32(dayKeyFor(date)) % HAIL_ONE_IN === 0
}

/**
 * @param {Date} date
 * @param {{hemisphere?: string, timeZone?: string}} [opts]
 * @returns {Readonly<{kind: string, season: string, hemisphere: string}>}
 */
export function precipitationFor (date, opts) {
  const explicit = opts && opts.hemisphere
  const hemisphere = explicit === 'north' || explicit === 'south'
    ? explicit
    : hemisphereFor(opts && opts.timeZone)

  if (!isDate(date)) {
    return Object.freeze({ kind: FALLBACK_KIND, season: seasonFor(date, hemisphere), hemisphere })
  }

  const season = seasonFor(date, hemisphere)
  let kind
  if (season === 'winter') kind = 'snow'
  else if (season === 'summer') kind = 'rain'
  else kind = isHailDay(date) ? 'hail' : 'rain'

  // Frozen for the same reason getSiteState() freezes: a renderer that mutated the
  // descriptor it was handed would be a decision-maker, quietly.
  return Object.freeze({ kind, season, hemisphere })
}

/**
 * Read a kind back off the DOM seam. Shares FALLBACK_KIND with `precipitationFor` on
 * purpose — the leaf's fallback and the renderer's fallback are one constant in one module,
 * because two defaults in two places is how they drift.
 */
export function parsePrecipitationKind (raw) {
  return PRECIPITATION_KINDS.includes(raw) ? raw : FALLBACK_KIND
}
