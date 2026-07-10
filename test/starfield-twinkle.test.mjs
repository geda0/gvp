import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TWINKLE_MIN,
  twinkle,
  makeTwinklePhase,
  makeTwinkleSpeed
} from '../js/starfield.js'

// The wake is not particulate dust — it is a star's interaction with the
// gravitational layers of spacetime, so it should SHIMMER: thin, star-coloured,
// and "random like fairies being". `twinkle` is the per-star shimmer applied to
// the wake's opacity as it is laid into the trail. Pure, so it is testable.

test('twinkle stays within [TWINKLE_MIN, 1] — the wake dims but never vanishes or blows out', () => {
  for (let t = 0; t < 20; t += 0.13) {
    for (const phase of [0, 1.1, 3.3, 6.0]) {
      const v = twinkle(phase, 2.5, t)
      assert.ok(v >= TWINKLE_MIN - 1e-9, `twinkle ${v} < TWINKLE_MIN at t=${t}`)
      assert.ok(v <= 1 + 1e-9, `twinkle ${v} > 1 at t=${t}`)
    }
  }
  assert.ok(TWINKLE_MIN > 0 && TWINKLE_MIN < 1, 'a shimmer, not a strobe and not a constant')
})

test('twinkle actually varies over time — a shimmer, not a fixed dimming', () => {
  const samples = new Set()
  for (let t = 0; t < 4; t += 0.05) samples.add(Math.round(twinkle(1.0, 3.0, t) * 100))
  assert.ok(samples.size > 5, 'the wake must breathe over time, not sit at one opacity')
})

test('it reaches both extremes across a full cycle', () => {
  let min = Infinity
  let max = -Infinity
  for (let t = 0; t < 10; t += 0.01) {
    const v = twinkle(0.7, 2.0, t)
    if (v < min) min = v
    if (v > max) max = v
  }
  assert.ok(Math.abs(min - TWINKLE_MIN) < 0.02, 'dims down to the floor')
  assert.ok(Math.abs(max - 1) < 0.02, 'brightens up to full')
})

test('two stars shimmer independently — fairies, not a synchronised pulse', () => {
  const p1 = 0.0
  const p2 = Math.PI // deliberately antiphase
  let everDiffer = false
  for (let t = 0; t < 5; t += 0.02) {
    if (Math.abs(twinkle(p1, 3.0, t) - twinkle(p2, 3.0, t)) > 0.1) { everDiffer = true; break }
  }
  assert.ok(everDiffer, 'stars with different phase must be out of sync')
})

test('random phase spans the whole cycle; random speed is a positive spread', () => {
  const phases = []
  const speeds = []
  for (let i = 0; i < 500; i++) { phases.push(makeTwinklePhase()); speeds.push(makeTwinkleSpeed()) }
  assert.ok(Math.min(...phases) < 0.5 && Math.max(...phases) > Math.PI * 2 - 0.5, 'phase covers ~[0, 2π)')
  assert.ok(Math.min(...speeds) > 0, 'every star shimmers (positive speed)')
  assert.ok(Math.max(...speeds) > Math.min(...speeds) + 0.3, 'speeds vary star to star, so they never lock into one rhythm')
})
