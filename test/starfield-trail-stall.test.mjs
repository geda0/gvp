import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { trailFramesToClear8Bit } from '../js/starfield-prefs.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

// Can a `destination-out` trail erase ever actually finish?
//
// THE DEFECT, and it has shipped TWICE. The night sky used to build its tails by not
// clearing: a `destination-out` erase at alpha 0.22 kept 78% of the previous frame. Canvas
// alpha is 8-bit, so each frame computes `round(a * 0.78)` — and that has a FIXED POINT:
//
//     round(2 * 0.78) = round(1.56) = 2
//     round(1 * 0.78) = round(0.78) = 1
//
// Alpha 1–2/255 never reaches 0. Every pixel a star had ever crossed kept a permanent veil,
// and the veil accumulated screen-wide. The fix shipped, was silently reverted along with
// two other correct fixes, and the regression came back on prod months later.
//
// WHY A PREDICATE AND NOT A RENDERING TEST. The arithmetic above is the whole bug, and it is
// pure: no canvas, no frames, no screenshot, no flake. A rendering test for this would have
// to run hundreds of frames and then assert "no pixel is still dim", which is slow, needs a
// browser, and reports a symptom. This reports the CAUSE, in one call, and it fails the
// instant someone proposes an erase alpha that cannot converge — before it is wired to
// anything.
//
// WHAT THE REPO DOES TODAY, measured so this test is not read as describing live code: the
// time-mode night path does a FULL `clearRect` every frame (js/starfield.js), and the legacy
// `drawSpace()` wash is `source-over` with an opaque colour, which composites colour rather
// than multiplying alpha and so has no stall of this kind. There is no partial
// `destination-out` erase in the renderer. This predicate exists so that if one is ever
// proposed again — and it was, twice — the number has to clear the bar before it ships.

test('the shipped 0.22 erase NEVER clears, and the predicate says so in one call', () => {
  assert.equal(
    trailFramesToClear8Bit(0.22, 255), Infinity,
    'round(a * 0.78) has a fixed point at a = 1 and a = 2, so alpha 1-2/255 is permanent. ' +
    'Infinity is the honest answer: not "a lot of frames", not a large number someone might ' +
    'read as acceptable — it never happens'
  )
})

test('a large enough erase does clear, in a bounded number of frames', () => {
  // 0.59 is the tier drawSpace() uses, and 0.66 the reduced-motion one.
  for (const alpha of [0.59, 0.66]) {
    const frames = trailFramesToClear8Bit(alpha, 255)
    assert.ok(
      Number.isFinite(frames) && frames > 0,
      `${alpha} must converge; got ${frames}`
    )
    assert.ok(
      frames < 30,
      `${alpha} takes ${frames} frames to clear — over half a second at 60fps is a visible ` +
      'smear, not a trail'
    )
  }
  assert.equal(trailFramesToClear8Bit(1, 255), 1, 'a full erase clears in one frame')
})

test('the boundary is found by the arithmetic, not by a number someone typed', () => {
  // Somewhere between 0.22 and 0.59 the fixed point disappears. Whatever that threshold is,
  // it must be a real cliff: everything below stalls forever and everything above converges.
  // Asserting the cliff's SHAPE rather than its value means a future canvas rounding change
  // moves the number without silently invalidating the test.
  let lastStalling = null
  let firstClearing = null
  for (let i = 1; i <= 99; i++) {
    const alpha = i / 100
    const frames = trailFramesToClear8Bit(alpha, 255)
    if (!Number.isFinite(frames)) lastStalling = alpha
    else if (firstClearing === null) firstClearing = alpha
  }
  assert.ok(firstClearing !== null, 'some alpha must converge, or the predicate is broken')
  assert.ok(
    lastStalling !== null && lastStalling < firstClearing,
    `the stalling range must be a contiguous block BELOW the clearing range — got last ` +
    `stalling ${lastStalling}, first clearing ${firstClearing}. A stall above a clear would ` +
    'mean the model of 8-bit rounding is wrong'
  )
})

test('a starting alpha that is already zero needs no frames', () => {
  assert.equal(trailFramesToClear8Bit(0.59, 0), 0)
})

test('a nonsensical erase alpha is refused rather than answered', () => {
  for (const bad of [0, -0.5, 1.5, NaN, null, 'half']) {
    assert.throws(
      () => trailFramesToClear8Bit(bad, 255), /alpha/i,
      `${JSON.stringify(bad)} must throw. An erase of 0 removes nothing and would loop ` +
      'forever; returning Infinity for it would blur "this alpha stalls" into "this input ' +
      'was meaningless", and those want different fixes'
    )
  }
})

test('the renderer has no partial destination-out erase to stall on', () => {
  // The other half of the regression: the predicate is only a bar if something checks that
  // the renderer has not quietly gone back to a partial erase. MEASURED today — the night
  // path clears fully, and drawSpace()'s wash is source-over with an opaque colour, which
  // composites colour instead of multiplying alpha.
  const src = readFileSync(join(REPO, 'js', 'starfield.js'), 'utf8')
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.doesNotMatch(
    code, /globalCompositeOperation\s*=\s*['"]destination-out['"]/,
    'the renderer sets destination-out. If a partial trail erase is coming back, it has to ' +
    'come with an alpha that trailFramesToClear8Bit says converges — and with this ' +
    'assertion updated to say which path is allowed to use it, deliberately'
  )
})
