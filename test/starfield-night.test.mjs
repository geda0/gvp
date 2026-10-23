import test from 'node:test'
import assert from 'node:assert/strict'
import { trailFramesToClear8Bit, spaceTrailAlphaForPreference } from '../js/starfield-prefs.js'

// The night sky as RESTORED to the original (c7a09b6) on 2026-10-23 - see
// test/starfield-original.test.mjs for the code-identity pin. A counting canvas stub pins:
//   1. the night frame applies the ORIGINAL trail: keep (1 - trail) of the last frame, as a
//      full-canvas destination-out (the canvas is transparent over the CSS sky), at an alpha
//      that converges in 8-bit - so no permanently-stuck ghost pixels;
//   2. invariant #6: reduced motion still draws stars but draws ZERO motion streaks.
// This file used to pin the opposite (zero gradients, a full clear): that was the design the
// owner rejected, retired with it.

function makeGradient() {
  return { addColorStop() {} }
}

function makeCtx(counters) {
  const ctx = {
    _composite: 'source-over',
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    createRadialGradient() { counters.createRadialGradient++; return makeGradient() },
    createLinearGradient() { counters.createLinearGradient++; return makeGradient() },
    fillRect(...a) { counters.fillRect++; counters.fillRectArgs.push([ctx._composite, ctx.fillStyle, ...a]) },
    // Record the args: "the frame clears" is only true if it clears the WHOLE canvas.
    clearRect(...a) { counters.clearRect++; counters.clearRectArgs.push(a) },
    drawImage(img) {
      counters.drawImage++
    },
    stroke() { counters.stroke++ },
    beginPath() {}, arc() { counters.arc++ }, fill() { counters.fill++ },
    moveTo() {}, lineTo() {},
    save() {}, restore() {},
    translate() {},
    rotate() {}, scale() {}, setTransform() {}
  }
  Object.defineProperty(ctx, 'globalCompositeOperation', {
    get() { return ctx._composite },
    set(v) { ctx._composite = v; counters.compositeOps.add(v) }
  })
  return ctx
}

function makeCanvas(counters) {
  const ctx = makeCtx(counters)
  return { width: 0, height: 0, getContext: () => ctx }
}

const VIEWPORT = { width: 1200, height: 800 }

/** Boot starfield in time mode and hand back a frame() we can pump. */
async function bootStarfield({ reducedMotion = false, hours = '22', cores = 6 } = {}) {
  const counters = {
    createRadialGradient: 0, createLinearGradient: 0,
    fillRect: 0, clearRect: 0, drawImage: 0, stroke: 0,
    clearRectArgs: [], fillRectArgs: [], arc: 0, fill: 0,
    compositeOps: new Set()
  }
  const mainCanvas = makeCanvas(counters)
  let frameCb = null

  globalThis.document = {
    getElementById: () => mainCanvas,
    createElement: () => makeCanvas(counters), // sprite canvases
    addEventListener() {},
    visibilityState: 'visible',
    documentElement: {
      hasAttribute: (a) => a === 'data-time', // living time-of-day mode ON
      dataset: { timeHours: hours }
    }
  }
  globalThis.window = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    navigator: { hardwareConcurrency: cores },
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {} }),
    addEventListener() {},
    requestAnimationFrame: (cb) => { frameCb = cb; return 1 },
    cancelAnimationFrame() {}
  }

  const { initStarfield } = await import('../js/starfield.js?perf=' + Math.random())
  initStarfield('canvas', { getTheme: () => 'space' })

  assert.ok(frameCb, 'starfield must schedule a frame via requestAnimationFrame')
  return { counters, pump: (t) => frameCb(t) }
}


function reset(counters) {
  for (const k of ['createRadialGradient', 'createLinearGradient', 'fillRect', 'clearRect', 'drawImage', 'stroke', 'arc', 'fill']) counters[k] = 0
  counters.clearRectArgs = []
  counters.fillRectArgs = []
  counters.compositeOps = new Set()
}

test('the night frame applies the original trail: a full-canvas erase at the original alpha', async () => {
  const { counters, pump } = await bootStarfield()
  reset(counters)
  pump()
  const erase = counters.fillRectArgs.find(([op]) => op === 'destination-out')
  assert.ok(erase, 'the night frame must fade the last frame (the original trail), not clear it')
  const [, style, x, y, w, h] = erase
  assert.deepEqual([x, y, w, h], [0, 0, VIEWPORT.width, VIEWPORT.height], 'the WHOLE canvas fades')
  assert.equal(style, `rgba(0, 0, 0, ${spaceTrailAlphaForPreference(false)})`)
  assert.equal(counters.clearRect, 0, 'no full clear at night - that is what erased the original look')
})

test('the original trail alpha converges in 8-bit: no permanently-stuck ghost pixels', () => {
  const frames = trailFramesToClear8Bit(spaceTrailAlphaForPreference(false), 255)
  assert.ok(Number.isFinite(frames) && frames <= 8, `a full-bright pixel must fade out within 8 frames (got ${frames})`)
  // The value that DID stall, kept as the counter-example this guards against.
  assert.equal(trailFramesToClear8Bit(0.22, 255), Infinity)
})

// Project invariant #6 (reduced motion), live-render clause: streaks are suppressed, stars stay.
test('reduced motion draws stars but no motion streaks (invariant #6, live clause)', async () => {
  const rm = await bootStarfield({ reducedMotion: true })
  reset(rm.counters)
  rm.pump(); rm.pump(); rm.pump()
  assert.ok(rm.counters.arc > 0 && rm.counters.fill > 0, 'reduced-motion users must still see stars')
  assert.equal(rm.counters.stroke, 0, 'reduced motion must draw zero motion streaks')

  const normal = await bootStarfield({ reducedMotion: false })
  reset(normal.counters)
  normal.pump(); normal.pump(); normal.pump()
  assert.ok(normal.counters.stroke > 0, 'default motion draws streaks (guards against a vacuous assertion above)')
})

test('a high-refresh display renders the 60Hz sky: frames inside the reference interval are skipped', async () => {
  const { counters, pump } = await bootStarfield()
  pump(1000)
  reset(counters)
  pump(1000 + 1000 / 120) // a 120Hz vsync: too soon
  assert.equal(counters.arc, 0, 'a frame 8ms after the last drawn one must not draw (or move) the sky')
  pump(1000 + 1000 / 60)
  assert.ok(counters.arc > 0, 'the next 60Hz-spaced frame draws')
})

test('star density does not follow the CPU: 4 and 16 cores draw the same sky', async () => {
  const few = await bootStarfield({ cores: 4 })
  reset(few.counters); few.pump()
  const many = await bootStarfield({ cores: 16 })
  reset(many.counters); many.pump()
  assert.ok(few.counters.arc > 0)
  assert.equal(many.counters.arc, few.counters.arc, 'a stronger machine must not get a denser (heavier) sky')
})
