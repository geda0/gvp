import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRECIPITATION_KINDS,
  SEASONS,
  SHOULDER_SEASONS,
  HAIL_ONE_IN,
  FALLBACK_KIND,
  hemisphereFor,
  dayKeyFor,
  seasonFor,
  isHailDay,
  precipitationFor,
  parsePrecipitationKind
} from '../js/precipitation.js'

// What falls from the daytime sky, and why (ADR-0016 §2).
//
// Today the daytime theme has snow and only snow — in July, in Sydney, everywhere. This is
// the leaf that decides; `js/starfield.js` only obeys (§3).
//
// The leaf is PURE and TOTAL. Pure because the renderer runs on requestAnimationFrame and
// an exception in the decision path does not produce a wrong colour — it stops the
// animation loop for the rest of the session. Total for the same reason: invariant #12's
// posture, clamp and never throw.

// A LOCAL date, deliberately not `new Date('2026-03-20')`. An ISO date-only string parses
// as UTC MIDNIGHT per spec, so west of Greenwich it is the previous day locally — which
// shifted every golden pin by one and made 2026-03-01 read as February. The leaf is local
// by design (the shipped clock reads getHours()), so the test has to be too. This is the
// exact trap the leaf's "local month, not UTC" decision exists to avoid, met from the
// other side.
const d = (iso) => {
  const [y, m, day] = iso.split('-').map(Number)
  return new Date(y, m - 1, day)
}

test('the exported vocabulary is the contract the renderer reads', () => {
  assert.deepEqual([...PRECIPITATION_KINDS], ['snow', 'rain', 'hail'])
  assert.deepEqual([...SEASONS], ['winter', 'spring', 'summer', 'autumn'])
  assert.deepEqual([...SHOULDER_SEASONS], ['spring', 'autumn'])
  assert.equal(HAIL_ONE_IN, 9)
  assert.equal(
    FALLBACK_KIND, 'rain',
    'the fallback is rain, and snow is the ONE wrong answer: snow in July is the bug M3 ' +
    'exists to fix, so a fallback of snow would make the bug survive its own fix in the one ' +
    'case nobody tests'
  )
})

// ---------------------------------------------------------------- seasons

test('seasonFor uses meteorological, month-aligned boundaries', () => {
  // Astronomical seasons move by a day or two per year and need an ephemeris; the WMO
  // boundaries are exact and need only getMonth(). The entire visible difference is WHICH
  // OF TWO ADJACENT DAYS flips snow to rain.
  const north = {
    winter: ['2026-12-05', '2026-01-15', '2026-02-20'],
    spring: ['2026-03-01', '2026-04-10', '2026-05-31'],
    summer: ['2026-06-01', '2026-07-04', '2026-08-30'],
    autumn: ['2026-09-10', '2026-10-23', '2026-11-07']
  }
  for (const [season, days] of Object.entries(north)) {
    for (const day of days) {
      assert.equal(seasonFor(d(day), 'north'), season, `${day} should be northern ${season}`)
    }
  }
})

test('the southern hemisphere is the same table six months away — a property, not a copy', () => {
  // Two tables is 24 facts that can disagree. One table plus this identity makes a
  // southern-hemisphere typo structurally impossible rather than merely untested.
  for (let month = 0; month < 12; month++) {
    const here = new Date(2026, month, 15)
    const opposite = new Date(2026, (month + 6) % 12, 15)
    assert.equal(
      seasonFor(here, 'south'), seasonFor(opposite, 'north'),
      `month ${month}: southern must equal the northern season six months away`
    )
  }
})

test('the season comes from the LOCAL month, matching the clock the sky already uses', () => {
  // js/theme-time.js reads getHours(), so the shipped clock is local wall-clock. A UTC month
  // would put the December→January flip at a different instant from the midnight the sky
  // wraps at.
  const local = new Date(2026, 0, 15, 12, 0, 0)
  assert.equal(seasonFor(local, 'north'), 'winter')
  assert.equal(dayKeyFor(local), 20260115, 'dayKeyFor is the local calendar triple')
})

// ---------------------------------------------------------------- hemisphere

test('hemisphereFor reads an IANA zone id, and defaults north', () => {
  for (const zone of ['Australia/Sydney', 'Pacific/Auckland', 'America/Sao_Paulo',
    'America/Argentina/Buenos_Aires', 'Africa/Johannesburg', 'Antarctica/McMurdo']) {
    assert.equal(hemisphereFor(zone), 'south', `${zone} is southern`)
  }
  for (const zone of ['Europe/London', 'America/New_York', 'Asia/Tokyo', 'UTC']) {
    assert.equal(hemisphereFor(zone), 'north', `${zone} is northern`)
  }
})

test('an unknown or missing zone collapses to north rather than inventing a third state', () => {
  // The two populations that produce "unknown" are opposites: a browser with no Intl is
  // overwhelmingly northern (that is where the browsers are), and a zone missing from a
  // 30-entry allowlist is probably somewhere the allowlist does not need. Telling both of
  // them "no season" is worse for both than guessing the majority and SAYING SO in the
  // descriptor, which is why the guess is reported back rather than hidden.
  for (const zone of ['', null, undefined, 'Mars/Olympus', 42, {}]) {
    assert.equal(hemisphereFor(zone), 'north')
  }
})

test('the leaf never touches Intl — the zone is injected', () => {
  // The same trick as ADR-0015 §4.2's ctx.wide. It also means the suite cannot go red
  // because of the host's locale data: on a Node build without full ICU,
  // resolvedOptions().timeZone answers 'UTC'.
  const src = [hemisphereFor, seasonFor, precipitationFor].map((f) => f.toString()).join('\n')
  // A USE, not a mention: hemisphereFor's own comment explains why a browser without Intl
  // is treated as northern, and a bare-word match failed on that explanation. The fix for
  // that failure would have been to delete the reasoning.
  assert.doesNotMatch(
    src, /\bIntl\s*\./,
    'the leaf must not read Intl. The DOM layer resolves the zone and passes it in, so this ' +
    'stays a pure function of its arguments'
  )
})

// ---------------------------------------------------------------- the hail lottery

test('hail lands about one day in nine', () => {
  let hail = 0
  const start = new Date(2026, 0, 1)
  for (let i = 0; i < 3650; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    if (isHailDay(day)) hail++
  }
  const rate = 3650 / hail
  assert.ok(
    rate > HAIL_ONE_IN * 0.9 && rate < HAIL_ONE_IN * 1.1,
    `hail fell on 1 day in ${rate.toFixed(2)}, expected about 1 in ${HAIL_ONE_IN}`
  )
})

test('hail days are not a LATTICE — the assertion that fails if the mixer is simplified away', () => {
  // This is the row that matters. `dayKey % 9` has the right RATE and a visible lattice:
  // 10000 ≡ 1 and 100 ≡ 1 (mod 9), so dayKey % 9 ≡ (y + m + d) % 9, and consecutive days
  // increment the residue by one — hail on exactly every ninth day, forever, learnable in a
  // month. A rate test passes against that happily. Only the GAP STRUCTURE tells them apart.
  const days = []
  const start = new Date(2026, 0, 1)
  for (let i = 0; i < 3650; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    if (isHailDay(day)) days.push(i)
  }
  const gaps = new Set()
  for (let i = 1; i < days.length; i++) gaps.add(days[i] - days[i - 1])

  assert.ok(
    gaps.has(1),
    'no two consecutive hail days in a decade. A hash produces short spells; a lattice ' +
    `never can. Gaps seen: ${[...gaps].sort((a, b) => a - b).join(', ')}`
  )
  assert.ok(
    [...gaps].some((g) => g > 20),
    'no long dry spell in a decade — the gaps are too regular to be a hash'
  )
  assert.ok(
    gaps.size > 20,
    `only ${gaps.size} distinct gap lengths in a decade; a lattice produces a handful. ` +
    'If this fails, someone replaced the mixer with plain arithmetic'
  )
})

test('the lottery is a fact about the DAY, not about where you are or what season it is', () => {
  // A northern and a southern visitor on the same date both get hail — one in spring, one
  // in autumn. The lottery is global; the season decides whether that day's weather is a
  // kind that can hail.
  const day = d('2026-03-20')
  assert.equal(isHailDay(day), true, 'golden pin')
  assert.equal(
    precipitationFor(day, { hemisphere: 'north' }).kind, 'hail',
    'northern spring + a hail day'
  )
  assert.equal(
    precipitationFor(day, { hemisphere: 'south' }).kind, 'hail',
    'southern autumn + the same hail day'
  )
})

test('golden days, so a re-roll of everyone\'s calendar cannot pass silently', () => {
  assert.equal(isHailDay(d('2026-03-20')), true)
  assert.equal(isHailDay(d('2026-04-03')), true)
  assert.equal(isHailDay(d('2026-10-23')), false)
  assert.equal(isHailDay(d('2026-11-07')), false)

  // The row that proves the lottery is consulted only in shoulder seasons: a WINTER day
  // that wins the lottery must still answer snow.
  assert.equal(isHailDay(d('2026-01-15')), true, 'a winter day can win the lottery')
  assert.equal(
    precipitationFor(d('2026-01-15'), { hemisphere: 'north' }).kind, 'snow',
    'and winter still answers snow — the lottery is the lottery, not the forecast'
  )
})

test('the hour never changes the answer', () => {
  // So the weather does not shift under a visitor who is watching, and so the time slider
  // cannot re-roll it by dragging.
  const kinds = new Set()
  for (let hour = 0; hour < 24; hour++) {
    kinds.add(precipitationFor(new Date(2026, 2, 20, hour, 30), { hemisphere: 'north' }).kind)
  }
  assert.equal(kinds.size, 1, `the kind changed during the day: ${[...kinds].join(', ')}`)
})

// ---------------------------------------------------------------- the decision

test('the season table decides the kind', () => {
  const kindOn = (iso, hemisphere = 'north') => precipitationFor(d(iso), { hemisphere }).kind
  assert.equal(kindOn('2026-01-15'), 'snow', 'winter')
  assert.equal(kindOn('2026-07-04'), 'rain', 'summer')
  assert.equal(kindOn('2026-10-23'), 'rain', 'autumn, no hail that day')
  assert.equal(kindOn('2026-07-04', 'south'), 'snow', 'southern July is winter')
  assert.equal(kindOn('2026-01-15', 'south'), 'rain', 'southern January is summer')
})

test('the descriptor carries the two inputs the caller cannot recover from the answer', () => {
  const got = precipitationFor(d('2026-07-04'), { hemisphere: 'south' })
  assert.deepEqual({ ...got }, { kind: 'snow', season: 'winter', hemisphere: 'south' })
  assert.ok(
    Object.isFrozen(got),
    'frozen for the same reason getSiteState() freezes: a renderer that mutated the ' +
    'descriptor it was handed would be a decision-maker, quietly'
  )
  assert.deepEqual(
    Object.keys(got).sort(), ['hemisphere', 'kind', 'season'],
    'no counts, no speeds, no colours — starfield-prefs.js is the single source of truth ' +
    'for those, and a descriptor carrying them would make this the SECOND source'
  )
})

test('opts.hemisphere wins, then the timezone, then north', () => {
  assert.equal(precipitationFor(d('2026-07-04'), { hemisphere: 'south' }).hemisphere, 'south')
  assert.equal(
    precipitationFor(d('2026-07-04'), { timeZone: 'Australia/Sydney' }).hemisphere, 'south',
    'the zone resolves it when no explicit hemisphere is given'
  )
  assert.equal(
    precipitationFor(d('2026-07-04'), { hemisphere: 'north', timeZone: 'Australia/Sydney' }).hemisphere,
    'north',
    'an explicit hemisphere overrides the zone'
  )
  assert.equal(precipitationFor(d('2026-07-04'), {}).hemisphere, 'north')
  assert.equal(precipitationFor(d('2026-07-04')).hemisphere, 'north', 'opts itself is optional')
})

// ---------------------------------------------------------------- totality

test('nothing throws, ever — an exception here stops the animation loop for the session', () => {
  for (const input of [null, undefined, 'nope', 42, {}, [], new Date('not a date'), NaN]) {
    let got
    assert.doesNotThrow(
      () => { got = precipitationFor(input, { hemisphere: 'north' }) },
      `precipitationFor(${JSON.stringify(input) ?? String(input)}) threw`
    )
    assert.equal(
      got.kind, FALLBACK_KIND,
      'an unusable date falls back to rain: unseasonal at worst, never absurd, and never ' +
      'the snow-in-July the milestone exists to remove'
    )
    assert.ok(SEASONS.includes(got.season), 'the descriptor stays well-formed')
  }
  assert.doesNotThrow(() => seasonFor(null, 'north'))
  assert.doesNotThrow(() => isHailDay(null))
  assert.doesNotThrow(() => dayKeyFor(null))
})

test('parsePrecipitationKind shares the leaf\'s fallback rather than keeping its own', () => {
  for (const kind of PRECIPITATION_KINDS) assert.equal(parsePrecipitationKind(kind), kind)
  for (const bad of ['', null, undefined, 'sleet', 'SNOW', 42, {}]) {
    assert.equal(
      parsePrecipitationKind(bad), FALLBACK_KIND,
      'the renderer\'s fallback and the leaf\'s fallback must be the same constant in the ' +
      'same module — two defaults in two places is how they drift'
    )
  }
})
