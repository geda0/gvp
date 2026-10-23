import test from 'node:test'
import assert from 'node:assert/strict'

import { starDrawBounds, starIsOffCanvas, STREAK_BOUNDS_PAD } from '../js/starfield-geom.js'
// The renderer owns the streak width. This test reaches for it on purpose: the width must be
// ONE number, read from the star, never a copy of it living in the culling module.
import { streakThickness, STAR_MAX_RADIUS } from '../js/starfield.js'

// Is this star going to put a single pixel on the canvas?
//
// M1 slice 3. The sandbox measured ~36% of stars drawn entirely OFF-SCREEN at 1080p: the
// projection throws them outward as `z` shrinks, and the canvas clipped every one of those
// pixels anyway. Skipping them is exact — the cheapest kind of optimisation, because the
// rendered result is identical by definition rather than by measurement.
//
// A CULL IS ASYMMETRIC, AND THAT DECIDES EVERY ROW HERE. A wrong `false` costs one
// unnecessary drawImage that the canvas then clips — invisible, and the exact cost we have
// today. A wrong `true` DELETES A VISIBLE STAR, which is a rendering defect that will not
// show up in any unit test and reads as flicker in the corner of someone's eye. So the
// predicate is CONSERVATIVE by construction: every bound is inflated, never shaved, and
// every uncertain input answers "draw it".
//
// WHAT A STAR ACTUALLY PUTS ON THE CANVAS, measured from js/starfield.js's `show()`:
//   - the glow sprite, an axis-aligned box [x-radius, y-radius, 2r, 2r];
//   - when it is moving, a streak from a tail point back along the motion vector to the
//     head at (x, y), stroked STREAK_THICKNESS wide and CENTRED on that segment.
// So the union is the glow box joined with the segment's own box inflated by half the
// thickness — plus a pad for antialiasing and round caps, which put ink slightly outside
// the geometric extent.

const W = 1920
const H = 1080

test('a star in the middle of the canvas is never culled', () => {
  assert.equal(starIsOffCanvas({ x: 960, y: 540, radius: 4 }, W, H), false)
})

test('a star far outside, with no streak, is culled', () => {
  assert.equal(starIsOffCanvas({ x: -500, y: 540, radius: 4 }, W, H), true)
  assert.equal(starIsOffCanvas({ x: 960, y: H + 500, radius: 4 }, W, H), true)
  assert.equal(starIsOffCanvas({ x: W + 200, y: -200, radius: 4 }, W, H), true)
})

test('a star whose GLOW still reaches the canvas is kept, though its centre does not', () => {
  // The centre is off the left edge by 6px and the glow radius is 9 (STAR_MAX_RADIUS), so
  // 3px of glow is on screen. Culling on the centre alone — the obvious implementation —
  // would delete it.
  assert.equal(
    starIsOffCanvas({ x: -6, y: 540, radius: 9 }, W, H), false,
    'the bound is the drawn EXTENT, not the centre. A centre-only test culls every star ' +
    'that is halfway off an edge, which is a bright rim of missing light along all four sides'
  )
})

test('a star off-screen whose STREAK crosses the canvas is kept', () => {
  // The head is past the right edge; the tail is still inside. The streak is the longest
  // thing a star draws (up to STREAK_MAX_DIST = 150), so ignoring it is the easiest way to
  // make this predicate wrong in the dangerous direction.
  assert.equal(
    starIsOffCanvas({ x: W + 40, y: 540, radius: 2, tailX: W - 100, tailY: 540 }, W, H), false,
    'the streak is drawn from the tail to the head; a head outside the canvas does not mean ' +
    'the comet is outside it'
  )
})

test('a streak entirely outside is culled along with its star', () => {
  assert.equal(
    starIsOffCanvas({ x: W + 300, y: 540, radius: 2, tailX: W + 160, tailY: 540 }, W, H), true
  )
})

test('the bound covers the streak THICKNESS, not just its centreline', () => {
  // A horizontal streak running just above the top edge. Its centreline is off-canvas, but
  // it is stroked STREAK_THICKNESS wide and centred, so the lower half is on-canvas.
  const justAbove = -(STREAK_BOUNDS_PAD + 0.5)
  assert.equal(
    starIsOffCanvas({ x: 900, y: justAbove, radius: 0, tailX: 700, tailY: justAbove }, W, H),
    false,
    'the streak is centred on its segment, so half its width sits on each side. A bound ' +
    'drawn on the centreline clips a line of light along the top edge'
  )
})

test('the pad keeps a star that only antialiasing would reach', () => {
  // Exactly on the edge: geometric extent touches x = 0 and nothing more. Round caps and AA
  // still put ink there, so it must be drawn.
  assert.equal(starIsOffCanvas({ x: -4, y: 540, radius: 4 }, W, H), false)
  assert.ok(
    STREAK_BOUNDS_PAD >= 1,
    'the pad exists for antialiasing and round caps, which put ink outside the geometric ' +
    'extent; anything under a pixel is not a pad'
  )
})

test('an uncertain input is never culled', () => {
  // The predicate runs per star per frame, so a NaN from a degenerate projection must not
  // silently blank a region of the sky. `NaN < 0` is false and `NaN > w` is false, so a
  // naive comparison chain answers "on screen" by accident — this asserts it is on purpose.
  for (const star of [
    { x: NaN, y: 540, radius: 4 },
    { x: 960, y: NaN, radius: 4 },
    { x: 960, y: 540, radius: NaN },
    { x: 960, y: 540, radius: 4, tailX: NaN, tailY: 540 },
    {},
    null
  ]) {
    assert.equal(
      starIsOffCanvas(star, W, H), false,
      `${JSON.stringify(star)} must be DRAWN. A cull is only ever allowed on a bound it is ` +
      'certain about — the failure mode of guessing is a hole in the sky nobody can reproduce'
    )
  }
})

test('a zero-area canvas culls nothing, rather than culling everything', () => {
  // Before the first resize the canvas can be 0x0. Culling everything there would blank the
  // sky on the first frames, which reads as a slow load rather than as a bug.
  assert.equal(starIsOffCanvas({ x: 10, y: 10, radius: 2 }, 0, 0), false)
})

test('starDrawBounds reports the union, and is the thing the predicate uses', () => {
  const b = starDrawBounds({ x: 100, y: 100, radius: 10, tailX: 40, tailY: 100 })
  assert.ok(b.left <= 40 - STREAK_BOUNDS_PAD, `left ${b.left} must reach the tail`)
  assert.ok(b.right >= 110, `right ${b.right} must reach the glow`)
  assert.ok(b.top <= 90 && b.bottom >= 110, 'the glow box must be inside the union')

  // Exposed separately because M1's later slices need the box itself, not just the verdict:
  // a draw path that already has the bounds should not compute them twice.
  assert.deepEqual(
    starIsOffCanvas({ x: 100, y: 100, radius: 10, tailX: 40, tailY: 100 }, W, H),
    false
  )
})

// A star is bounded by the width of ITS OWN streak, not by a copy of a constant.
//
// The streak is no longer one width for every star: `streakThickness(radius)` in
// js/starfield.js keeps 1.5px as the hairline FLOOR a distant pinprick gets and grows the
// width with the star's radius — 5.4px for the closest star the renderer can draw (radius
// STAR_MAX_RADIUS = 9). This module USED TO inflate the streak's segment box by a hardcoded
// 0.75 — half of the OLD one-size thickness, copied into a second module — so for every star
// above the floor the bound under-covered the ink it was supposed to contain.
//
// UNDER-COVERING IS THE FORBIDDEN DIRECTION, per this module's own header: "A wrong `false`
// costs one `drawImage` the canvas then clips — invisible, and exactly what is paid today. A
// wrong `true` DELETES A VISIBLE STAR: a rendering defect no unit test would show, reading
// as flicker at the edge of someone's vision. So bounds are inflated and never shaved." A
// star whose fat streak genuinely still paints canvas pixels, culled because the bound was
// computed for a hairline, IS that wrong `true` — and it selects for the CLOSEST, brightest
// stars, as a flicker along the screen edges. No existing row here can see it: they all
// describe the old thin streak.
//
// THE GEOMETRY. Head at (864, -30), tail at (960, -2): a 96-28-100 segment above the top
// edge, the star travelling up and to the left. The strip is CENTRED on that segment
// (js/starfield.js draws it from -thickness/2), and perpendicular to this segment is
// (0.28, -0.96), so a 5.4px streak puts its lower edge 2.7 * 0.96 = 2.59px below the
// centreline: the tail corner lands at y = +0.59, ON CANVAS. The head's glow cannot save it
// — radius 9 at y = -30 stops 21px short of the edge. Inflating by 0.75 instead puts the
// bottom bound at -0.25 and deletes the star.
test('a star is bounded by its OWN streak width, so a close star with a fat streak is not culled', () => {
  const closest = { x: 864, y: -30, radius: 9, tailX: 960, tailY: -2 }
  const thickness = streakThickness(STAR_MAX_RADIUS)
  const half = thickness / 2
  const fat = { ...closest, streakThickness: thickness }

  assert.equal(
    starIsOffCanvas(fat, W, H), false,
    `a ${thickness}px streak reaches ${half}px off its centreline, so this one still paints ` +
    'the top row of the canvas. Culling it is the wrong `true` this module forbids — the ' +
    'brightest stars in the sky flickering out along the edges'
  )

  const b = starDrawBounds(fat)
  assert.ok(
    b.bottom >= closest.tailY + half,
    `bottom ${b.bottom} must clear the streak's lower edge at ${closest.tailY + half}`
  )
  assert.ok(
    b.right >= closest.tailX + half,
    `right ${b.right} must clear the streak's outer edge at ${closest.tailX + half}; the ` +
    'half-width applies on BOTH axes, because the streak runs at any angle'
  )

  // The fallback, as a RELATION rather than a verdict.
  //
  // This used to assert `starIsOffCanvas(closest) === true`, which happened to sit 0.25px
  // from flipping (bottom -0.25 against a needed < 0). That coupled the row to two numbers
  // it is not about: bump STREAK_BOUNDS_PAD from 1 to 1.25 — an ordinary antialiasing retune
  // the test above explicitly permits — and it failed with a message about the hairline. Far
  // worse, making the fallback MORE conservative, which this module's header calls the
  // correct direction, also failed it. A test that forbids a strictly-safer change is
  // pinning the implementation, not the behaviour.
  //
  // What the fallback actually claims is comparative: declaring a width may only ever WIDEN
  // the box, never narrow it.
  assert.ok(
    starDrawBounds(closest).bottom < starDrawBounds(fat).bottom,
    'the box may only widen for a star that declares its own width — a declared width that ' +
    'narrowed the bounds would shave them, which deletes visible stars'
  )

  // And the cull still culls, on a fixture with room to spare rather than a knife edge: 18px
  // clear of the top on a tail that no permitted width can reach back onto the canvas.
  const farOff = { x: 864, y: -60, radius: 9, tailX: 960, tailY: -20 }
  assert.equal(
    starIsOffCanvas(farOff, W, H), true,
    'a star genuinely clear of the canvas is still culled, whatever its streak width'
  )
})
