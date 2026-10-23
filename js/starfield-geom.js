/**
 * Off-canvas culling for the starfield (M1 slice 3). Pure: no canvas, no module state.
 *
 * The perspective projection throws stars outward as `z` shrinks, and ~36% of them end up
 * drawn entirely off-screen at 1080p — the canvas clipped every one of those pixels anyway.
 * Skipping them is EXACT rather than approximate: the rendered result is identical by
 * definition, not by measurement, which is what makes this the cheapest kind of win.
 *
 * A CULL IS ASYMMETRIC, and that decides every line below. A wrong `false` costs one
 * `drawImage` the canvas then clips — invisible, and exactly what is paid today. A wrong
 * `true` DELETES A VISIBLE STAR: a rendering defect no unit test would show, reading as
 * flicker at the edge of someone's vision. So bounds are inflated and never shaved, and an
 * input this module is not certain about is always drawn.
 */

/**
 * Antialiasing and round caps put ink slightly outside the geometric extent, and the glow
 * sprite's own alpha ramp does not stop cleanly at its box edge.
 */
export const STREAK_BOUNDS_PAD = 1

/**
 * Fallback half-width for a star that does not declare its own: half of js/starfield.js's
 * STREAK_THICKNESS, which is now the HAIRLINE FLOOR rather than the width every star gets.
 *
 * A star SHOULD carry `streakThickness`, because the width is proportional to the star's
 * radius since the lollipop fix — up to 5.4px for the closest star (`streakThickness(9)`,
 * the radius ceiling `clampStarRadius` enforces). Inflating that star's segment box by 0.75
 * instead of 2.7 under-covers its streak by 1.95px on every side, and under-covering is the
 * wrong `true` this module's header forbids: a star with ink still on the canvas gets
 * culled, which reads as the BRIGHTEST stars flickering out along the screen edges.
 */
const STREAK_HALF_THICKNESS = 0.75

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * The union of everything a star draws this frame, padded.
 *
 * @param {{x: number, y: number, radius: number, tailX?: number, tailY?: number}} star
 * @returns {{left: number, top: number, right: number, bottom: number} | null}
 *   null when the inputs cannot be trusted — the caller must then draw.
 */
export function starDrawBounds (star) {
  if (!star || !finite(star.x) || !finite(star.y) || !finite(star.radius)) return null

  const r = Math.abs(star.radius)
  let left = star.x - r
  let right = star.x + r
  let top = star.y - r
  let bottom = star.y + r

  // The streak runs from the tail point to the head at (x, y) and is the longest thing a
  // star draws (up to STREAK_MAX_DIST). Ignoring it is the easiest way to make this
  // predicate wrong in the dangerous direction.
  const hasTail = star.tailX !== undefined && star.tailY !== undefined
  if (hasTail) {
    if (!finite(star.tailX) || !finite(star.tailY)) return null
    // This star's own half-width, NEVER NARROWER than the hairline fallback.
    //
    // The Math.max is the whole safety argument, not a tidy-up. Without it a declared width
    // below the hairline — anything in (0, 1.5) — would inflate LESS than the old constant
    // did: 1.0 gives half 0.5 against 0.75, a 0.25px shave per side. Shaving is the wrong
    // `true` this module's header forbids, and no producer should be able to reach it by
    // accident. js/starfield.js cannot today, because streakThickness floors at 1.5, but a
    // bound that depends on a caller's floor is not a bound.
    //
    // A non-finite or non-positive value contributes 0 and so falls back, rather than
    // propagating NaN into the comparisons below — NaN makes every one of them false, which
    // would cull a star that should be drawn.
    const declared = finite(star.streakThickness) && star.streakThickness > 0
      ? star.streakThickness / 2
      : 0
    const half = Math.max(STREAK_HALF_THICKNESS, declared)
    // The segment's own box, inflated by half the stroke width on both axes. Slightly loose
    // at the caps of a diagonal streak, which is the safe direction.
    left = Math.min(left, Math.min(star.x, star.tailX) - half)
    right = Math.max(right, Math.max(star.x, star.tailX) + half)
    top = Math.min(top, Math.min(star.y, star.tailY) - half)
    bottom = Math.max(bottom, Math.max(star.y, star.tailY) + half)
  }

  return {
    left: left - STREAK_BOUNDS_PAD,
    top: top - STREAK_BOUNDS_PAD,
    right: right + STREAK_BOUNDS_PAD,
    bottom: bottom + STREAK_BOUNDS_PAD
  }
}

/**
 * True only when this star provably puts no pixel on the canvas.
 *
 * @param {{x: number, y: number, radius: number, tailX?: number, tailY?: number}} star
 * @param {number} width
 * @param {number} height
 */
export function starIsOffCanvas (star, width, height) {
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) {
    // A 0x0 canvas happens before the first resize. Culling everything there would blank the
    // sky for the first frames, which reads as a slow load rather than as a bug.
    return false
  }
  const b = starDrawBounds(star)
  if (!b) return false
  return b.right < 0 || b.left > width || b.bottom < 0 || b.top > height
}
