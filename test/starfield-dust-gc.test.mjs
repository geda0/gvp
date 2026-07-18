// WHY — the "star dust" fixed point.
// The night sky fades trails with destination-out + rgba(0,0,0,0.22): every frame the
// 8-bit ALPHA channel becomes round(a * 0.78). Rounding gives it a FLOOR it can never
// cross: round(2*0.78)=2 and round(1*0.78)=1. So alpha 1 and 2 stall FOREVER, and every
// value above them descends INTO that stall. Result: every pixel a star ever crossed
// keeps a permanent sub-perceptual veil (measured live: 37%->43% of canvas in 10s).
// The fix must not change prod's LOOK, so we touch nothing about compositing, the fade
// constant, blends, or star rendering. We add a garbage collector that zeroes ONLY the
// pixels the fade provably cannot reach (alpha <= the derived stall floor, <=2/255, well
// under the perceptual threshold). The visible decay 255 -> 3 is never disturbed.
// Cost: a full-canvas getImageData+putImageData measured 14.9ms (a whole 60fps frame).
// A ~10-row band measured 0.2ms median / 0.6ms max — so the GC is INCREMENTAL: a fixed
// row band per frame, a cursor cycling the canvas, constant cost at any viewport height.
// The load-bearing property is NO GAPS: an uncovered row is dust that never gets collected.

import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
// Namespace import so a not-yet-existing export fails as an ASSERTION, not a link error.
import * as starfield from '../js/starfield.js'
import {
  alphaStalls,
  dustAlphaFloor,
  DUST_SWEEP_ROWS,
  sweepBandRect,
  nextSweepCursor,
  collectDust
} from '../js/starfield.js'

const PROD_FADE = 0.22

test('alphaStalls: under the prod 0.22 fade every alpha funnels into a fixed point and never reaches 0', () => {
  assert.equal(alphaStalls(1, PROD_FADE), true)
  assert.equal(alphaStalls(2, PROD_FADE), true)
  assert.equal(alphaStalls(3, PROD_FADE), true)
  assert.equal(alphaStalls(200, PROD_FADE), true)
})

test('alphaStalls: a total erase reaches 0 immediately, so nothing stalls', () => {
  assert.equal(alphaStalls(1, 1), false)
  assert.equal(alphaStalls(2, 1), false)
  assert.equal(alphaStalls(255, 1), false)
})

// alphaStalls is an EXPORTED SEAM, so it must be total: for a fade <= 0 the iterate
// a -> round(a * (1 - fade)) never shrinks, so the `while (a !== 0)` loop runs forever
// and locks whatever called it (the render loop, or the test runner). The implementation
// needs an ITERATION CAP (or an early return for fade <= 0): a pixel that a fade can never
// remove is, by definition, stalled -> true.
// Run in a worker with a hard deadline so a non-terminating implementation FAILS FAST
// instead of hanging the whole suite.
function alphaStallsInWorker (cases, ms = 5000) {
  const src = `
    const { parentPort, workerData } = require('node:worker_threads')
    import(workerData.url).then((m) => {
      parentPort.postMessage(workerData.cases.map(([a, f]) => m.alphaStalls(a, f)))
    })
  `
  const worker = new Worker(src, {
    eval: true,
    workerData: { url: new URL('../js/starfield.js', import.meta.url).href, cases }
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error(`alphaStalls did not terminate within ${ms}ms for ${JSON.stringify(cases)}`))
    }, ms)
    worker.on('message', (results) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(results)
    })
    worker.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

test('alphaStalls: a fade that can never remove anything terminates and reports the pixel as stalled', async () => {
  const [negative, zero] = await alphaStallsInWorker([[2, -0.5], [2, 0]])
  assert.equal(negative, true, 'a negative fade grows alpha forever — stalled, not an infinite loop')
  assert.equal(zero, true, 'a zero fade never clears the pixel')
})

test('dustAlphaFloor: derived from the fade — 0.22 sticks at 2, a full erase leaves no dust', () => {
  assert.equal(dustAlphaFloor(PROD_FADE), 2)
  assert.equal(dustAlphaFloor(1), 0)
})

test('dustAlphaFloor: every alpha at or below the floor stalls under that fade', () => {
  const floor = dustAlphaFloor(PROD_FADE)
  for (let a = 1; a <= floor; a++) {
    assert.equal(alphaStalls(a, PROD_FADE), true)
  }
})

// The mandate the whole GC rests on: prod's LOOK is preserved exactly, so the collector
// is only ever licensed to erase pixels NO ONE CAN SEE (alpha <= ~2/255, ~0.8% opacity).
// dustAlphaFloor derives its threshold from the fade, and that derivation is unbounded:
// the largest stalling alpha is floor(0.5 / fade), which GROWS as the fade softens —
// 0.01 -> 50, 0.002 -> 250. A gentler fade would hand the GC a licence to erase the
// VISIBLE starfield. The derived floor must therefore be clamped by a hard, sub-perceptual
// ceiling: the GC may never be authorized to touch a perceptible pixel.
test('dustAlphaFloor: the GC may never be authorized to touch a perceptible pixel, however gentle the fade', () => {
  assert.ok(
    Number.isInteger(starfield.DUST_MAX_FLOOR) && starfield.DUST_MAX_FLOOR <= 3,
    'DUST_MAX_FLOOR is the sub-perceptual ceiling on anything the GC may erase'
  )
  assert.ok(dustAlphaFloor(0.01) <= starfield.DUST_MAX_FLOOR)
  assert.ok(dustAlphaFloor(0.002) <= starfield.DUST_MAX_FLOOR)

  for (let fade = 0.001; fade <= 1; fade += 0.001) {
    assert.ok(
      dustAlphaFloor(fade) <= starfield.DUST_MAX_FLOOR,
      `fade ${fade} authorized erasing alpha ${dustAlphaFloor(fade)}, above the ceiling`
    )
  }
})

test('sweepBandRect: full-width band at the cursor row', () => {
  assert.deepEqual(sweepBandRect(0, 12, 400, 579), { x: 0, y: 0, w: 400, h: 12 })
  assert.deepEqual(sweepBandRect(120, 12, 400, 579), { x: 0, y: 120, w: 400, h: 12 })
})

test('sweepBandRect: clips at the bottom edge so it never reads past the canvas', () => {
  const height = 579
  const band = sweepBandRect(height - 3, 12, 400, height)
  assert.equal(band.h, 3)
  assert.equal(band.y + band.h, height)
})

test('sweepBandRect: height is always positive for a cursor inside the canvas', () => {
  const height = 579
  for (let cursor = 0; cursor < height; cursor++) {
    assert.ok(sweepBandRect(cursor, 12, 400, height).h > 0)
  }
})

test('nextSweepCursor: advances by the band height and wraps at the bottom', () => {
  assert.equal(nextSweepCursor(0, 12, 579), 12)
  assert.equal(nextSweepCursor(120, 12, 579), 132)
  assert.equal(nextSweepCursor(576, 12, 579), 0)
})

test('nextSweepCursor: one full cycle covers every row exactly once with no gaps, at any viewport height', () => {
  const rows = 12
  const heights = [...Array(200).keys()].map((i) => i + 1).concat([579, 1080, 1440, 2160])
  for (const height of heights) {
    const covered = new Array(height).fill(0)
    let cursor = 0
    do {
      const band = sweepBandRect(cursor, rows, 400, height)
      for (let y = band.y; y < band.y + band.h; y++) covered[y]++
      cursor = nextSweepCursor(cursor, rows, height)
    } while (cursor !== 0)
    assert.deepEqual(covered, new Array(height).fill(1), `height ${height} is not covered exactly once`)
  }
})

test('collectDust: zeroes stuck pixels in place and leaves every live pixel byte-identical', () => {
  const floor = dustAlphaFloor(PROD_FADE)
  const data = new Uint8ClampedArray([
    40, 60, 80, 2, // dust: at the floor -> fully cleared
    0, 0, 0, 0, // already empty -> untouched, not counted
    10, 20, 30, 4, // still visibly fading -> must keep its exact bytes
    255, 255, 255, 255 // bright star -> untouched
  ])

  const collected = collectDust(data, floor)

  assert.equal(collected, 1)
  assert.deepEqual(
    Array.from(data),
    [0, 0, 0, 0, 0, 0, 0, 0, 10, 20, 30, 4, 255, 255, 255, 255]
  )
})
