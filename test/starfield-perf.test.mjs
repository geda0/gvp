import test from 'node:test'
import assert from 'node:assert/strict'
import { NIGHT_BLEND_MODE, DAY_BLEND_MODE, TRAIL_FADE_ALPHA } from '../js/starfield.js'

// No jsdom here — a counting canvas stub pins the render's load-bearing properties:
//   1. a frame allocates ZERO gradients (sprites are baked once, at init)
//   2. the night trail fades on COLOUR (source-over), never `destination-out`,
//      which is what stranded alpha at 2 and grew a permanent veil
//   3. night screen-blends an opaque canvas; day composites normally
//   4. reduced motion draws stars but no streaks (project invariant #6, live clause)

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
    fillRect(...a) { counters.fillRect++; counters.fillRectCalls.push({ args: a, fillStyle: ctx.fillStyle, composite: ctx._composite }) },
    clearRect(...a) { counters.clearRect++; counters.clearRectArgs.push(a) },
    drawImage() { counters.drawImage++ },
    stroke() { counters.stroke++ },
    beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
    save() {}, restore() {},
    // Only the streak draw translates — an exact probe for "was a streak drawn".
    translate() { counters.translate++ },
    rotate() {}, scale() {}, setTransform() {}
  }
  Object.defineProperty(ctx, 'globalCompositeOperation', {
    get() { return ctx._composite },
    set(v) { ctx._composite = v; counters.compositeOps.add(v) }
  })
  return ctx
}

const VIEWPORT = { width: 1200, height: 800 }

function makeCanvas(counters, main = false) {
  const ctx = makeCtx(counters)
  const style = {}
  const el = { width: 0, height: 0, style, getContext: () => ctx }
  if (main) {
    Object.defineProperty(style, 'mixBlendMode', {
      get() { return style._m },
      set(v) { style._m = v; counters.blendModes.push(v) },
      configurable: true
    })
  }
  return el
}

/** Boot starfield in time mode and hand back a frame() we can pump. */
async function bootStarfield({ reducedMotion = false, hours = '22' } = {}) {
  const counters = {
    createRadialGradient: 0, createLinearGradient: 0,
    fillRect: 0, clearRect: 0, drawImage: 0, stroke: 0, translate: 0,
    fillRectCalls: [], clearRectArgs: [], blendModes: [],
    compositeOps: new Set()
  }
  const mainCanvas = makeCanvas(counters, true)
  let frameCb = null

  globalThis.document = {
    getElementById: () => mainCanvas,
    createElement: () => makeCanvas(counters), // sprite canvases
    addEventListener() {},
    visibilityState: 'visible',
    documentElement: {
      hasAttribute: (a) => a === 'data-time',
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

function reset(counters) {
  counters.createRadialGradient = 0
  counters.createLinearGradient = 0
  counters.fillRect = 0
  counters.clearRect = 0
  counters.drawImage = 0
  counters.stroke = 0
  counters.translate = 0
  counters.fillRectCalls = []
  counters.clearRectArgs = []
  counters.blendModes = []
  counters.compositeOps = new Set()
}

test('drawing frames allocates zero gradients (sprites are baked once, at init)', async () => {
  const { counters, pump } = await bootStarfield()
  reset(counters) // gradients built during the sprite bake are fine; frames must allocate none

  pump(); pump(); pump() // 2nd+ frames have a previous position, so streaks draw too

  assert.equal(counters.createRadialGradient, 0,
    `star bodies must drawImage a cached sprite, not build a radial gradient per star per frame (saw ${counters.createRadialGradient})`)
  assert.equal(counters.createLinearGradient, 0,
    `motion streaks must not build a linear gradient per star per frame (saw ${counters.createLinearGradient})`)
  assert.ok(counters.drawImage > 0, 'stars should still be drawn (via sprite drawImage)')
  assert.equal(counters.stroke, 0, 'the streak is a sprite now, not a stroked gradient line')
})

test('the night trail fades on colour, never with destination-out', async () => {
  const { counters, pump } = await bootStarfield({ hours: '22' })
  reset(counters)
  pump()

  assert.ok(!counters.compositeOps.has('destination-out'),
    'destination-out fades ALPHA, which rounds up and strands pixels at alpha 2 forever — fade colour instead')

  // the opaque base is also a source-over fillRect ('#000'); the FADE is the translucent one
  const fade = counters.fillRectCalls.find((f) => f.composite === 'source-over' && f.fillStyle.startsWith('rgba('))
  assert.ok(fade, 'the night frame must fade with a translucent source-over fillRect')
  assert.deepEqual(fade.args, [0, 0, VIEWPORT.width, VIEWPORT.height], 'the fade must cover the whole canvas')
  assert.equal(fade.fillStyle, `rgba(0, 0, 0, ${TRAIL_FADE_ALPHA})`,
    'the fade must keep the original 0.22 decay curve — the look depends on it')
})

test('night screen-blends the canvas; day composites normally', async () => {
  const night = await bootStarfield({ hours: '22' })
  night.pump()
  assert.equal(night.counters.blendModes.at(-1), NIGHT_BLEND_MODE,
    'an opaque black night canvas only reads as transparent under screen blending')

  const day = await bootStarfield({ hours: '12' })
  day.pump()
  assert.equal(day.counters.blendModes.at(-1), DAY_BLEND_MODE,
    'snow must alpha-composite over the garden, not screen onto a bright sky')
})

test('the night canvas gets an opaque base, but only once — not every frame', async () => {
  const { counters, pump } = await bootStarfield({ hours: '22' })
  reset(counters)
  pump()
  const opaqueBase = (cs) => cs.fillRectCalls.filter((f) => f.fillStyle === '#000').length
  assert.equal(opaqueBase(counters), 1, 'first night frame paints the opaque base')

  reset(counters)
  pump(); pump(); pump()
  assert.equal(opaqueBase(counters), 0,
    're-painting the opaque base every frame would erase the trail it exists to hold')
})

test('reduced motion draws stars but no motion streaks (invariant #6, live clause)', async () => {
  const rm = await bootStarfield({ reducedMotion: true })
  reset(rm.counters)
  rm.pump(); rm.pump(); rm.pump()

  assert.ok(rm.counters.drawImage > 0, 'reduced-motion users must still see stars')
  assert.equal(rm.counters.translate, 0, 'reduced motion must draw zero motion streaks')

  const normal = await bootStarfield({ reducedMotion: false })
  reset(normal.counters)
  normal.pump(); normal.pump(); normal.pump()
  assert.ok(normal.counters.translate > 0,
    'default motion should draw streaks (guards against a vacuous assertion above)')
})
