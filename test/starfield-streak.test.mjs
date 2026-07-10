import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STREAK_TAIL_FRAMES,
  STREAK_MAX_DIST,
  STREAK_MIN_THICKNESS,
  STREAK_MAX_THICKNESS,
  streakLength,
  streakThickness,
  compensateForClearedTrail
} from '../js/starfield.js'

// The old night render built its trail by NOT clearing — a `destination-out` erase
// at 0.22 kept 78% of the previous frame, so glow piled up over ~14 frames. That
// accumulation never fully drained (8-bit alpha rounding strands pixels at ~2/255),
// so the sky filled with permanent haze.
//
// Splitting that into its two jobs: the STREAK is just the original short motion
// line (one frame of travel, thin). The lingering, sky-filling glow is STARDUST —
// motes shed behind the star that fade on their own age (see starfield-dust.test).
// Stretching the streak instead was a dead end: it produced a mantis-ray wing.

test('the streak is a short motion line, scaled to the travel of the frames it spans', () => {
  assert.ok(STREAK_TAIL_FRAMES >= 1)
  const perFrameDelta = 2
  assert.equal(streakLength(perFrameDelta), perFrameDelta * STREAK_TAIL_FRAMES)
  assert.equal(streakLength(perFrameDelta, 1), perFrameDelta, 'one frame of travel == the original px->x line')
})

test('the tail is clamped so a fast/respawned star cannot smear across the screen', () => {
  assert.equal(streakLength(10_000), STREAK_MAX_DIST)
  assert.ok(streakLength(10_000) <= STREAK_MAX_DIST)
})

test('a motionless star draws no tail', () => {
  assert.equal(streakLength(0), 0)
})

test('tail length scales linearly with per-frame motion', () => {
  assert.equal(streakLength(1) * 3, streakLength(3))
})

// Brightness/tail compensation exists to repay ONE debt: the accumulation that the
// old default-motion night path built up on an uncleared canvas. Paths that already
// cleared every frame owe nothing, and must not be brightened or lengthened.
//   - old reduced-motion night erased at alpha 1  -> a FULL clear, never accumulated
//   - the daytime path already called clearRect    -> never accumulated
test('only the default-motion night path is compensated for the removed accumulation', () => {
  const night = false
  const day = true
  assert.equal(compensateForClearedTrail(false, night), true,
    'default-motion night lost its accumulated glow — compensate')
  assert.equal(compensateForClearedTrail(true, night), false,
    'reduced-motion night already erased at alpha 1 (full clear) — brightening it is an unasked a11y regression')
  assert.equal(compensateForClearedTrail(false, day), false,
    'the daytime path already cleared every frame — nothing to repay')
  assert.equal(compensateForClearedTrail(true, day), false)
})

test('an uncompensated path draws a single-frame streak, not an 8-frame comet', () => {
  assert.equal(streakLength(2, 1), 2)
  assert.equal(streakLength(2, STREAK_TAIL_FRAMES), 2 * STREAK_TAIL_FRAMES)
  assert.equal(streakLength(10_000, 1), STREAK_MAX_DIST, 'the clamp still applies without a tail multiplier')
})

// Two artifacts, one dimension. Scaling the streak to a fixed hairline under a big
// round glow gives a LOLLIPOP (candy on a stick). Scaling it to the glow's DIAMETER
// gives a MANTIS RAY (a wide triangular wing). The original was a 1.5px stroked line,
// and the sky's brightness came from the accumulation, not from a fat streak — so the
// streak stays thin and BOUNDED, and stardust carries the glow.
test('the streak stays a thin line — never a mantis-ray wing on close stars', () => {
  assert.ok(streakThickness(1000) <= STREAK_MAX_THICKNESS,
    'an arbitrarily close star must not grow triangular wings')
  assert.ok(streakThickness(40) <= STREAK_MAX_THICKNESS)
  assert.ok(STREAK_MAX_THICKNESS <= 4, 'the original streak was a 1.5px line; keep it in that family')
})

test('thickness grows gently with the glow, then clamps', () => {
  assert.ok(streakThickness(6) >= streakThickness(1), 'never shrinks as a star closes in')
  assert.ok(streakThickness(1000) >= streakThickness(6))
})

test('far/sub-pixel stars keep a visible hairline streak (a floor, not zero)', () => {
  assert.equal(streakThickness(0), STREAK_MIN_THICKNESS)
  assert.equal(streakThickness(0.1), STREAK_MIN_THICKNESS)
  assert.ok(STREAK_MIN_THICKNESS > 0)
})
