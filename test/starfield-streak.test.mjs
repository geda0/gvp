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

// THE LOLLIPOP. Measured in a real browser on live prod, 2026-10-23: instrumenting the
// space-theme canvas over 90 frames put star draw sizes at p50 2.4px, p95 12.4px and
// max 150px. So the HEAD grows with proximity — the baked glow sprite is scaled to
// `clampStarRadius(...)`, capped at STAR_MAX_RADIUS = 9, i.e. up to 18px across — while
// the STICK does not: the streak strip is stretched to `tail x STREAK_THICKNESS` and
// STREAK_THICKNESS is a constant 1.5px for every star at every depth. A close star is
// therefore an 18px ball on a 1.5px stick, a 12:1 head-to-tail silhouette, and that
// silhouette is the single most-disliked thing about the current sky.
//
// A tail has to be the width of the thing it trails, so thickness becomes a function of
// the star's radius — proportional (not a constant, and not a curve so flat it is a
// constant in disguise), still a hairline for a distant pinprick so faint stars are never
// fattened, and bounded above so the closest star draws a tail and not a slab.
//
// 1.5px is kept here as the HAIRLINE CEILING for a pinprick: at p50 it is already the
// right order of magnitude, so it is what faint stars must not exceed — not what every
// star gets.
const HAIRLINE_CEILING = 1.5

test('streak thickness tracks the star radius, so a close star trails a tail and not a stick', async () => {
  const { streakThickness, STAR_MAX_RADIUS } = await import('../js/starfield.js')
  assert.equal(typeof streakThickness, 'function',
    'streak width must be derivable from the star radius through a pure seam, like streakLength')

  // The closest star's silhouette: head diameter against tail thickness.
  const headDiameter = STAR_MAX_RADIUS * 2
  const closest = streakThickness(STAR_MAX_RADIUS)
  const ratio = headDiameter / closest
  assert.ok(ratio <= 4,
    `lollipop: a ${headDiameter}px head on a ${closest}px tail is ${ratio.toFixed(1)}:1 — prod measured 12:1`)

  // Proportional, not constant: double the radius must buy appreciably more tail.
  assert.ok(streakThickness(6) >= streakThickness(3) * 1.5,
    'thickness must scale with the star, not sit at a constant for every depth')
  assert.ok(streakThickness(1.2) < streakThickness(6.2),
    'the p50 star (2.4px across) must trail a thinner tail than the p95 star (12.4px across)')

  // Hairline floor: a distant pinprick still streaks, and never fattens.
  const pinprick = streakThickness(0.2)
  assert.ok(pinprick > 0, 'a faint star still trails something — the streak must not vanish')
  assert.ok(pinprick <= HAIRLINE_CEILING,
    'faint stars must stay hairline — widening them is a different, unasked-for change')

  // Bounded above: no arithmetic turns a tail into a slab.
  assert.ok(streakThickness(1e9) <= headDiameter,
    'a tail is never wider than the widest star is across')
})
