import test from 'node:test'
import assert from 'node:assert/strict'

// No jsdom in this repo — a counting canvas stub is enough to pin the two
// invariants that make the starfield cheap and clean:
//   1. a frame allocates ZERO gradients (sprites are built once, at init)
//   2. the night frame FULLY clears (no `destination-out` residue trail)

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
    fillRect() { counters.fillRect++ },
    // Record the args: "the frame clears" is only true if it clears the WHOLE canvas.
    clearRect(...a) { counters.clearRect++; counters.clearRectArgs.push(a) },
    drawImage() { counters.drawImage++ },
    stroke() { counters.stroke++ },
    beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
    save() {}, restore() {},
    // Only the streak draw translates — a cheap, exact probe for "was a streak drawn".
    translate() { counters.translate++ },
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
async function bootStarfield({ reducedMotion = false, hours = '22' } = {}) {
  const counters = {
    createRadialGradient: 0, createLinearGradient: 0,
    fillRect: 0, clearRect: 0, drawImage: 0, stroke: 0, translate: 0,
    clearRectArgs: [],
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
    navigator: { hardwareConcurrency: 6 },
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {} }),
    addEventListener() {},
    requestAnimationFrame: (cb) => { frameCb = cb; return 1 },
    cancelAnimationFrame() {}
  }

  const { initStarfield } = await import('../js/starfield.js?perf=' + Math.random())
  initStarfield('canvas', { getTheme: () => 'space' })

  assert.ok(frameCb, 'starfield must schedule a frame via requestAnimationFrame')
  return { counters, pump: () => frameCb() }
}

const bootNightStarfield = bootStarfield

function reset(counters) {
  counters.createRadialGradient = 0
  counters.createLinearGradient = 0
  counters.fillRect = 0
  counters.clearRect = 0
  counters.drawImage = 0
  counters.stroke = 0
  counters.translate = 0
  counters.clearRectArgs = []
  counters.compositeOps = new Set()
}

test('drawing frames allocates zero gradients (star sprites are built once, at init)', async () => {
  const { counters, pump } = await bootNightStarfield()
  reset(counters) // gradients built during init/sprite-bake are fine — frames must allocate none

  pump(); pump(); pump() // 2nd+ frames have a previous position, so streaks draw too

  assert.equal(counters.createRadialGradient, 0,
    `star bodies must drawImage a cached sprite, not build a radial gradient per star per frame (saw ${counters.createRadialGradient})`)
  assert.equal(counters.createLinearGradient, 0,
    `motion streaks must not build a linear gradient per star per frame (saw ${counters.createLinearGradient})`)
  assert.ok(counters.drawImage > 0, 'stars should still be drawn (via sprite drawImage)')
})

test('the night frame fully clears — no destination-out residue trail', async () => {
  const { counters, pump } = await bootNightStarfield()
  reset(counters)

  pump()

  assert.ok(counters.clearRect >= 1, 'night frame must clear the canvas each frame')
  // "Clears" is only honest if it clears the WHOLE canvas — a clearRect(0,0,1,1) must not pass.
  assert.deepEqual(counters.clearRectArgs[0], [0, 0, VIEWPORT.width, VIEWPORT.height],
    'the night frame must clear the entire canvas, not a sub-rect')
  assert.equal(counters.fillRect, 0,
    'a full-canvas fillRect on a night frame means a partial erase (the residue bug) is back')
  assert.ok(!counters.compositeOps.has('destination-out'),
    'the partial destination-out erase leaves permanently-stuck pixels (8-bit alpha rounding) — clear instead')
})

// Project invariant #6 (reduced motion), live-render clause: the ONLY reduced-motion
// behaviour in the shipped night path is that streaks are suppressed. Nothing pinned it.
test('reduced motion draws stars but no motion streaks (invariant #6, live clause)', async () => {
  const rm = await bootStarfield({ reducedMotion: true })
  reset(rm.counters)
  rm.pump(); rm.pump(); rm.pump()

  assert.ok(rm.counters.drawImage > 0, 'reduced-motion users must still see stars')
  assert.equal(rm.counters.translate, 0, 'reduced motion must draw zero motion streaks')
  assert.ok(rm.counters.clearRect >= 1, 'reduced-motion night must still clear each frame')

  const normal = await bootStarfield({ reducedMotion: false })
  reset(normal.counters)
  normal.pump(); normal.pump(); normal.pump()
  assert.ok(normal.counters.translate > 0, 'default motion should draw streaks (guards against a vacuous assertion above)')
})

// `translate === 0` above proves no STREAKS, but dust never calls translate, so it
// says nothing about dust. Comparing draw COUNTS across the two modes is also no
// good: reduced motion renders far fewer stars, which masks leaked dust.
//
// Count-independent signature instead: a filling dust pool makes each successive
// frame issue MORE drawImage calls, until it saturates. No dust => flat. Compare a
// mode against ITSELF over time, so the star count cancels out.
function drawsOnNextFrame(h) {
  reset(h.counters)
  h.pump()
  return h.counters.drawImage
}

test('reduced motion sheds no stardust (its per-frame draws stay flat over time)', async () => {
  const FRAMES = 30 // > DUST_LIFE_FRAMES, so a live pool would be saturating

  const rm = await bootStarfield({ reducedMotion: true })
  rm.pump() // prime (px/py set)
  const rmEarly = drawsOnNextFrame(rm)
  for (let i = 0; i < FRAMES; i++) rm.pump()
  const rmLate = drawsOnNextFrame(rm)

  assert.ok(rmEarly > 0, 'reduced motion still draws its stars')
  assert.equal(rmLate, rmEarly,
    `reduced motion must draw the same count every frame — a rising count means dust leaked past the guard (early=${rmEarly}, late=${rmLate})`)

  // The probe must be able to SEE dust, or the assertion above proves nothing.
  const normal = await bootStarfield({ reducedMotion: false })
  normal.pump()
  const nEarly = drawsOnNextFrame(normal)
  for (let i = 0; i < FRAMES; i++) normal.pump()
  const nLate = drawsOnNextFrame(normal)
  assert.ok(nLate > nEarly,
    `default motion must accumulate dust, so draws rise (early=${nEarly}, late=${nLate}) — otherwise the flat-count check above is vacuous`)
})
