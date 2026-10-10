import test from 'node:test'
import assert from 'node:assert/strict'

// Does the DRAW PATH actually apply the depth fade?
//
// This exists because of a bug I shipped. `starDepthFade` was defined, unit-tested,
// and mutation-tested — and never called. Stars popped out of existence at the near
// plane instead of dissolving, and the suite stayed green the whole time, because
// test/starfield-depth.test.mjs asserts the pure FUNCTION and nothing asserted the
// CALL SITE. Mutating the function was caught; "never call it" was invisible.
//
// So this is a wiring test, and it is deliberately the complement of the other one:
//   starfield-depth.test.mjs       — is the arithmetic right?
//   starfield-depth-wiring.test.mjs — is the arithmetic USED?
// A unit test on a pure helper can never answer the second question, and that gap is
// the whole reason a shipped visual regression sat behind a passing suite.
//
// The probe: at 22:00 the night path draws stars at full layer alpha (sp.star is 1,
// fireflies are 0), so any `globalAlpha` strictly between 0 and 1 can only be
// `layerAlpha * fade` with the fade engaged. Stars sweep the whole z range as frames
// run, so some land inside the fade band (0.15*W to 0.32*W) and must be drawn dimmed.

function makeGradient () {
  return { addColorStop () {} }
}

// Records every globalAlpha ASSIGNMENT, which is the thing under test.
function makeCtx (alphas) {
  const ctx = {
    _composite: 'source-over',
    _alpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    createRadialGradient () { return makeGradient() },
    createLinearGradient () { return makeGradient() },
    fillRect () {}, clearRect () {}, drawImage () {}, stroke () {},
    beginPath () {}, arc () {}, fill () {},
    moveTo () {}, lineTo () {},
    save () {}, restore () {},
    translate () {}, rotate () {}, scale () {}, setTransform () {}
  }
  Object.defineProperty(ctx, 'globalAlpha', {
    get () { return ctx._alpha },
    set (v) { ctx._alpha = v; alphas.push(v) }
  })
  Object.defineProperty(ctx, 'globalCompositeOperation', {
    get () { return ctx._composite },
    set (v) { ctx._composite = v }
  })
  return ctx
}

function makeCanvas (alphas) {
  const ctx = makeCtx(alphas)
  return { width: 0, height: 0, getContext: () => ctx }
}

const VIEWPORT = { width: 1200, height: 800 }

async function bootNight (hours = '22') {
  const alphas = []
  const mainCanvas = makeCanvas(alphas)
  let frameCb = null

  globalThis.document = {
    getElementById: () => mainCanvas,
    createElement: () => makeCanvas(alphas),
    addEventListener () {},
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
    matchMedia: () => ({ matches: false, addEventListener () {} }),
    addEventListener () {},
    requestAnimationFrame: (cb) => { frameCb = cb; return 1 },
    cancelAnimationFrame () {}
  }

  const { initStarfield } = await import('../js/starfield.js?depthwire=' + Math.random())
  initStarfield('canvas', { getTheme: () => 'space' })
  assert.ok(frameCb, 'starfield must schedule a frame via requestAnimationFrame')

  // Clear the init-time sprite-baking alphas; only frame draws are under test.
  alphas.length = 0
  return { alphas, pump: () => frameCb() }
}

test('the draw path dims stars by their depth fade, it does not merely define it', async () => {
  const { alphas, pump } = await bootNight()

  // Enough frames for stars to traverse into the fade band. Stars are seeded across
  // the z range and move toward the camera every frame, so this does not depend on
  // any single star's starting depth.
  for (let i = 0; i < 400; i++) pump()

  assert.ok(alphas.length > 0, 'the frame must set globalAlpha at all, or this probe is blind')

  const dimmed = alphas.filter(a => a > 0 && a < 1)
  assert.ok(
    dimmed.length > 0,
    'no star was ever drawn at a partial alpha across 400 night frames, so the depth ' +
    'fade is computed and discarded. starDepthFade must scale globalAlpha around the ' +
    "star's draw — this is the exact shape of the bug that shipped: defined, " +
    'unit-tested, never called. Observed alphas: ' +
    JSON.stringify([...new Set(alphas)].slice(0, 12))
  )
})

test('the fade is restored after each star, so one dim star cannot dim the layer', async () => {
  const { alphas, pump } = await bootNight()
  for (let i = 0; i < 200; i++) pump()

  // The draw saves the layer alpha, scales it, and must put it back. If it never
  // restored, alpha would ratchet toward 0 and nothing would be drawn at full
  // strength again — so a full-strength value must keep reappearing.
  assert.ok(
    alphas.includes(1),
    'globalAlpha never returns to 1 across 200 frames, so the per-star fade leaks into ' +
    'the layer and the sky dims permanently. The draw must restore the saved alpha. ' +
    'Observed: ' + JSON.stringify([...new Set(alphas)].slice(0, 12))
  )
})
