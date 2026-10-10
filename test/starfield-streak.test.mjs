import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STREAK_TAIL_FRAMES,
  STREAK_MAX_DIST,
  streakLength,
  compensateForClearedTrail
} from '../js/starfield.js'

// The old night render built its comet tail by NOT clearing — a `destination-out`
// erase at 0.22 kept 78% of the previous frame, so a star's glow piled up over
// ~14 frames. That accumulation never fully drained (8-bit alpha rounding leaves
// pixels stuck at alpha 1), so trails became permanent ghosts.
//
// The replacement draws the whole tail EVERY frame from a point N frames back,
// on a fully-cleared canvas: same comet, no accumulation, no residue.

test('the tail spans several frames of motion, not just one', () => {
  assert.ok(STREAK_TAIL_FRAMES > 1,
    'a one-frame streak is what made the cleared canvas look dead — the tail must span multiple frames')
  const perFrameDelta = 2
  assert.equal(streakLength(perFrameDelta), perFrameDelta * STREAK_TAIL_FRAMES)
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
