// WHY: a night star-trail must FINISH fading once its star has left the frame.
// Prod fades the ALPHA channel (destination-out + rgba black 0.22). 8-bit alpha
// ROUNDS at the bottom, so 2 * 0.78 = 1.56 rounds back up to 2 — the trail stalls
// at alpha 2 forever and every crossed pixel keeps a permanent veil. The fix
// decays the COLOUR channels of an opaque-black canvas (source-over rgba black
// 0.22): 8-bit colour TRUNCATES (Math.floor), so 1.56 floors to 1, then to 0 —
// the trail reaches exactly 0 and dies, oldest tail pixels first. CSS
// mix-blend-mode:screen makes that black identity so the sky shows through at
// night; day stays 'normal' (snow must alpha-composite over the garden). The
// prod curve (0.22) is unchanged — only the channel it decays in changes.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRAIL_FADE_ALPHA,
  trailFadeAlpha,
  trailFramesToClear,
  NIGHT_BLEND_MODE,
  DAY_BLEND_MODE,
  blendModeForScene
} from '../js/starfield.js'

test('preserves the prod trail-fade curve exactly (0.22)', () => {
  assert.equal(TRAIL_FADE_ALPHA, 0.22)
})

test('uses the prod fade normally but erases fully under reduced motion', () => {
  assert.equal(trailFadeAlpha(false), TRAIL_FADE_ALPHA)
  assert.equal(trailFadeAlpha(true), 1)
})

test('every trail terminates and a stronger fade clears in strictly fewer frames', () => {
  const sweep = [0.05, 0.22, 0.5, 0.9, 1]
  for (const fade of sweep) {
    const frames = trailFramesToClear(fade, 255)
    assert.ok(Number.isFinite(frames), `fade ${fade} should terminate`)
    assert.ok(frames > 0, `fade ${fade} should take at least one frame`)
  }
  assert.ok(trailFramesToClear(0.5) < trailFramesToClear(0.3))
  assert.ok(trailFramesToClear(0.3) < trailFramesToClear(0.1))
  const prodFrames = trailFramesToClear(TRAIL_FADE_ALPHA)
  assert.ok(Number.isFinite(prodFrames))
  assert.ok(prodFrames < 40)
})

test('night screens over the sky, day composites normally, and the scenes never share a mode', () => {
  assert.equal(NIGHT_BLEND_MODE, 'screen')
  assert.equal(DAY_BLEND_MODE, 'normal')
  assert.equal(blendModeForScene({ dayScene: false }), NIGHT_BLEND_MODE)
  assert.equal(blendModeForScene({ dayScene: true }), DAY_BLEND_MODE)
  assert.notEqual(NIGHT_BLEND_MODE, DAY_BLEND_MODE)
})
