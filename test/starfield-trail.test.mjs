import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRAIL_FADE_ALPHA,
  ORIGINAL_TRAIL_FADE_ALPHA,
  DEPOSIT_FRAMES,
  NIGHT_BLEND_MODE,
  DAY_BLEND_MODE,
  trailFadeAlpha,
  trailFramesToClear,
  fadeAlphaForClearFrames,
  blendModeForScene
} from '../js/starfield.js'

// WHY THIS SHAPE.
//
// The original night trail faded the canvas with
//   globalCompositeOperation = 'destination-out'; fillRect(rgba(0,0,0,0.22))
// which multiplies the ALPHA channel by 0.78 each frame. In 8-bit that rounds
// UP at the bottom: 2 * 0.78 = 1.56 -> 2. Alpha stalls at 2 forever, so every
// pixel a star ever touched keeps a permanent veil. Measured on the live
// original: pixels stuck at alpha 2 climbed 39% -> 58% of the canvas in 24s.
//
// Browser-verified asymmetry: the same 0.78 fade applied to a COLOUR channel
// TRUNCATES and reaches exactly 0 (at frame 19). So the trail moves to colour:
// paint the night canvas opaque black, fade colour toward black with the same
// 0.22 curve, and blend the canvas with `screen`, under which black is identity
// and the CSS sky shows through untouched.
//
// The trail's decay curve is unchanged. Only the channel it lives in changes.

// The fade VALUE is taste — the navigator tunes how intense the trail's build-up is.
// The BEHAVIOUR is the invariant: a bigger fade clears the trail in fewer frames, and
// every fade in (0,1] provably reaches pure black (the colour channel truncates).
test('the drawn fade is whatever the exported knob says', () => {
  assert.ok(TRAIL_FADE_ALPHA > 0 && TRAIL_FADE_ALPHA <= 1)
  assert.equal(trailFadeAlpha(false), TRAIL_FADE_ALPHA)
})

test('a bigger fade clears the trail in strictly fewer frames', () => {
  assert.ok(trailFramesToClear(0.5) < trailFramesToClear(0.3))
  assert.ok(trailFramesToClear(0.3) < trailFramesToClear(0.1))
})

test('every fade reaches pure black — colour truncates, so nothing can stall', () => {
  for (const a of [0.05, 0.22, 0.45, 0.9, 1]) {
    const n = trailFramesToClear(a)
    assert.ok(Number.isFinite(n) && n > 0, `fade ${a} must clear in finite frames`)
  }
})

test('the trail clears a lot faster than the original 0.22 curve', () => {
  const now = trailFramesToClear(TRAIL_FADE_ALPHA)
  const before = trailFramesToClear(ORIGINAL_TRAIL_FADE_ALPHA)
  assert.ok(now * 2 <= before,
    `the navigator asked for a much shorter build-up: ${now} frames vs the original ${before}`)
})

// THE LOAD-BEARING RULE. A star's glow sits on a given pixel for a median of ~3
// frames (measured from the real projection: p25 1.5, median 3.1, p75 6.6). The
// wake it leaves must not outlive that deposit — "the accumulation must not exist
// beyond as much time as it took to build". Everything else here is tuning; this
// is the constraint the tuning must satisfy.
test('the trail never outlives the deposit that made it', () => {
  const clears = trailFramesToClear(TRAIL_FADE_ALPHA)
  assert.ok(
    clears <= DEPOSIT_FRAMES,
    `the wake lingers ${clears} frames but a star only paints a pixel for ~${DEPOSIT_FRAMES} — it must not outlive its own build`
  )
})

test('the fade is DERIVED from the frame budget, not hand-tuned', () => {
  assert.equal(TRAIL_FADE_ALPHA, fadeAlphaForClearFrames(DEPOSIT_FRAMES))
})

test('the derived fade is the gentlest one that still meets the budget', () => {
  // Gentlest == longest surviving smear. Anything softer must blow the budget,
  // or we are clearing the trail more aggressively than the navigator asked.
  const a = fadeAlphaForClearFrames(DEPOSIT_FRAMES)
  assert.ok(trailFramesToClear(a) <= DEPOSIT_FRAMES)
  assert.ok(trailFramesToClear(a - 0.001) > DEPOSIT_FRAMES,
    'a softer fade would also fit the budget — we are fading harder than necessary and losing smear')
})

test('a tighter budget demands a harsher fade', () => {
  assert.ok(fadeAlphaForClearFrames(2) > fadeAlphaForClearFrames(3))
  assert.ok(fadeAlphaForClearFrames(3) > fadeAlphaForClearFrames(9))
})

test('reduced motion erases fully each frame — no trail at all', () => {
  assert.equal(trailFadeAlpha(true), 1, 'reduced-motion users must never accumulate a trail')
})

test('night blends with screen so an opaque black canvas reads as transparent', () => {
  assert.equal(NIGHT_BLEND_MODE, 'screen')
  assert.equal(blendModeForScene({ dayScene: false }), NIGHT_BLEND_MODE)
})

test('day blends normally — snow must alpha-composite over the garden, not screen onto it', () => {
  assert.equal(DAY_BLEND_MODE, 'normal')
  assert.equal(blendModeForScene({ dayScene: true }), DAY_BLEND_MODE)
})

test('the two scenes never share a blend mode', () => {
  assert.notEqual(blendModeForScene({ dayScene: true }), blendModeForScene({ dayScene: false }))
})
