import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateFullStarCount,
  defaultExperienceStarCount,
  STARFIELD_DEFAULT_EXPERIENCE
} from '../js/starfield-prefs.js'

// The star population has an ABSOLUTE ceiling, not just a relative one.
//
// MEASURED IN A REAL BROWSER, 2026-10-09, night path, per frame in `frame()`:
// a 2560x1440 desktop with 12 cores drew 3292 stars at 29.6-31.6ms/frame — a ~32fps
// ceiling with ZERO idle time, which is why the owner reported the chat response
// lagging too: the main thread had nothing left for SSE parsing or DOM updates. The
// same page on a phone (390x844, 6 cores, 153 stars) cost 1.8ms. A 16.4x gap.
//
// The cause is `calculateFullStarCount`'s `coresCount / 4` multiplier stacked on top
// of area scaling. Area scaling is LEGITIMATE — it holds star density per pixel
// constant, which is what makes the sky look the same on a laptop and a monitor. The
// cores multiplier is not: it is a "this machine can take it" heuristic, and it
// multiplies. Measured counts before the clamp: design point 1920x1080/4c = 646;
// desktop 2560x1440/12c = 3292 (5.1x the design density); 4K 3840x2160/16c = 9793
// (15x). The machine could not, in fact, take it.
//
// Note what this test does NOT do. It cannot measure frame cost — the canvas is
// stubbed everywhere in this suite, and `getImageData`'s dominant cost is a
// synchronous GPU pipeline flush that a stub cannot reproduce. So it pins the one
// thing that IS a pure function and IS the amplifier: the count. Everything else
// about the render budget needs a real-browser harness this repo does not have, and
// that gap is why a 2x-over-budget page sat behind a green suite.
const CORES_AT_DESIGN_POINT = 4
const DESIGN_W = 1920
const DESIGN_H = 1080

// Headroom over the design point is allowed to track AREA and nothing else.
const CEILING_AT_4K = 2600

test('the cores count never multiplies the star population above its area share', () => {
  const design = calculateFullStarCount(DESIGN_W, DESIGN_H, CORES_AT_DESIGN_POINT)
  assert.ok(design > 0, 'the design point must produce stars at all, or this test is vacuous')

  // Same viewport, more cores: the count must NOT grow. A faster CPU is not a reason
  // to draw a denser sky — it is only a reason to draw the same sky more smoothly.
  for (const cores of [8, 12, 16, 32]) {
    const scaled = calculateFullStarCount(DESIGN_W, DESIGN_H, cores)
    assert.equal(
      scaled, design,
      `${cores} cores at the design viewport produced ${scaled} stars vs ${design} at ` +
      `${CORES_AT_DESIGN_POINT} cores — the cores multiplier is back, and it is what took a ` +
      '2560x1440 desktop to 3292 stars and 29.6ms/frame'
    )
  }
})

test('star density per pixel is the same on a phone, a laptop and a 4K monitor', () => {
  const perPixel = (w, h, cores) => calculateFullStarCount(w, h, cores) / (w * h)
  const design = perPixel(DESIGN_W, DESIGN_H, CORES_AT_DESIGN_POINT)

  // Real device shapes, with the core counts those devices actually report.
  for (const [w, h, cores, label] of [
    [390, 844, 6, 'phone'],
    [1512, 950, 12, 'retina laptop'],
    [2560, 1440, 12, 'desktop'],
    [3440, 1440, 16, 'ultrawide'],
    [3840, 2160, 16, '4K']
  ]) {
    const ratio = perPixel(w, h, cores) / design
    // Floor only, because `Math.floor` rounds down and a phone's small area makes
    // that rounding a visible fraction. The ceiling is what this is guarding.
    assert.ok(
      ratio <= 1.02,
      `${label} (${w}x${h}, ${cores} cores) draws ${ratio.toFixed(2)}x the design density — ` +
      'density must not depend on the machine, only on the area'
    )
  }
})

test('the absolute population is bounded even on the largest plausible display', () => {
  const at4K = defaultExperienceStarCount(calculateFullStarCount(3840, 2160, 16))
  assert.ok(
    at4K <= CEILING_AT_4K,
    `a 4K 16-core display asks for ${at4K} stars, over the ${CEILING_AT_4K} ceiling. ` +
    'Measured: 3292 stars already cost 29.6ms/frame, so this is a frame-budget bound, ' +
    'not a tidiness preference'
  )
  assert.ok(at4K > 0, 'and it must still draw a sky')
})

test('the default experience still scales with the viewport, so the sky is not sparse', () => {
  const small = defaultExperienceStarCount(calculateFullStarCount(1280, 720, 4))
  const large = defaultExperienceStarCount(calculateFullStarCount(3840, 2160, 4))
  assert.ok(
    large > small,
    'a bigger viewport must still get more stars — the fix is to stop multiplying by ' +
    'cores, NOT to stop scaling by area'
  )
  assert.ok(
    STARFIELD_DEFAULT_EXPERIENCE.baseStars > 0,
    'the shared base count must exist for the ratios above to mean anything'
  )
})
