import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampHours,
  hoursFromDate,
  sceneParamsAt,
  skyStopsAt,
  skyGradientAt,
  chromeThemeAt,
  parseThemePref,
  serializeThemePref,
  resolveThemeHours,
} from '../js/theme-time.js'

const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps

test('clampHours wraps into [0,24)', () => {
  assert.equal(clampHours(9.5), 9.5)
  assert.equal(clampHours(24), 0)
  assert.equal(clampHours(26), 2)
  assert.equal(clampHours(-2), 22)
  assert.equal(clampHours(-26), 22)
})

test('hoursFromDate reads local wall-clock hours as a float', () => {
  assert.equal(hoursFromDate(new Date(2020, 0, 1, 9, 30)), 9.5)
  assert.equal(hoursFromDate(new Date(2020, 0, 1, 0, 0)), 0)
  assert.equal(hoursFromDate(new Date(2020, 0, 1, 23, 45)), 23.75)
})

test('scene params hit their keyframe extremes', () => {
  const midnight = sceneParamsAt(0)
  assert.equal(midnight.star, 1)
  assert.equal(midnight.sun, 0)

  const noon = sceneParamsAt(12)
  assert.equal(noon.sun, 1)
  assert.equal(noon.star, 0)

  const dusk = sceneParamsAt(19)
  assert.equal(dusk.firefly, 1)
})

test('every scene param stays within [0,1] across the whole day', () => {
  for (let h = 0; h < 24; h += 0.25) {
    const p = sceneParamsAt(h)
    for (const k of ['star', 'sun', 'firefly']) {
      assert.ok(p[k] >= 0 && p[k] <= 1, `${k} out of range at h=${h}: ${p[k]}`)
    }
  }
})

test('scene params are continuous — no jumps across a keyframe boundary', () => {
  const before = sceneParamsAt(11.98)
  const after = sceneParamsAt(12.02)
  assert.ok(approx(before.sun, after.sun), `sun jumped: ${before.sun} -> ${after.sun}`)
  assert.ok(approx(before.star, after.star))
})

test('scene params wrap continuously across midnight', () => {
  const beforeMidnight = sceneParamsAt(23.98)
  const afterMidnight = sceneParamsAt(0.02)
  assert.ok(approx(beforeMidnight.star, afterMidnight.star))
  assert.ok(approx(beforeMidnight.firefly, afterMidnight.firefly))
})

test('sun is high at midday and absent at night', () => {
  assert.ok(sceneParamsAt(12).sun > sceneParamsAt(8).sun)
  assert.ok(sceneParamsAt(8).sun > sceneParamsAt(3).sun)
  assert.equal(sceneParamsAt(3).sun, 0)
})

test('skyStopsAt returns three hex colors and matches keyframes exactly', () => {
  const noon = skyStopsAt(12)
  assert.equal(noon.length, 3)
  for (const c of noon) assert.match(c, /^#[0-9a-f]{6}$/i)
  // Daytime keyframe == the garden gradient stops.
  assert.deepEqual(skyStopsAt(9), ['#7eb0c8', '#a8cfae', '#4d7a58'])
})

test('skyGradientAt is a CSS linear-gradient embedding the interpolated stops', () => {
  const g = skyGradientAt(9)
  assert.match(g, /^linear-gradient\(/)
  assert.ok(g.includes('#7eb0c8') && g.includes('#a8cfae') && g.includes('#4d7a58'))
})

test('chromeThemeAt picks garden by day and space by night', () => {
  assert.equal(chromeThemeAt(12), 'garden')
  assert.equal(chromeThemeAt(13), 'garden')
  assert.equal(chromeThemeAt(2), 'space')
  assert.equal(chromeThemeAt(23), 'space')
  // Deep dusk leans to the dark (space) chrome as the stars take over.
  assert.equal(chromeThemeAt(19), 'space')
})

test('inputs are defensive: nullish / out-of-range hours never throw', () => {
  assert.doesNotThrow(() => sceneParamsAt(-5))
  assert.doesNotThrow(() => skyGradientAt(99))
  assert.equal(typeof chromeThemeAt(undefined), 'string')
})

test('parseThemePref: "time" is auto, "time:H" is pinned, legacy/empty → auto', () => {
  assert.deepEqual(parseThemePref('time'), { auto: true, hours: null })
  assert.deepEqual(parseThemePref('time:19.5'), { auto: false, hours: 19.5 })
  assert.deepEqual(parseThemePref('time:26'), { auto: false, hours: 2 })
  assert.deepEqual(parseThemePref('garden'), { auto: true, hours: null })
  assert.deepEqual(parseThemePref('space'), { auto: true, hours: null })
  assert.deepEqual(parseThemePref(null), { auto: true, hours: null })
  assert.deepEqual(parseThemePref(''), { auto: true, hours: null })
})

test('serializeThemePref round-trips the pinned hour and clamps it', () => {
  assert.equal(serializeThemePref({ auto: true, hours: null }), 'time')
  assert.equal(serializeThemePref({ auto: false, hours: 19.5 }), 'time:19.5')
  assert.equal(serializeThemePref({ auto: false, hours: 25 }), 'time:1')
})

test('resolveThemeHours: pinned returns the hour, auto reads the date', () => {
  assert.equal(resolveThemeHours({ auto: false, hours: 7 }, new Date(2020, 0, 1, 3, 0)), 7)
  assert.equal(resolveThemeHours({ auto: true, hours: null }, new Date(2020, 0, 1, 9, 30)), 9.5)
})

test('parse → serialize round-trips both modes', () => {
  assert.equal(serializeThemePref(parseThemePref('time')), 'time')
  assert.equal(serializeThemePref(parseThemePref('time:8.25')), 'time:8.25')
})
