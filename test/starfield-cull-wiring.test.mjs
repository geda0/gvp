import test from 'node:test'
import assert from 'node:assert/strict'

// Does the draw path actually SKIP off-canvas stars — and does it stay correct when it does?
//
// test/starfield-geom.test.mjs asserts the predicate. This asserts the call site, which is
// the half a pure unit test can never reach: this repo has already shipped a
// defined-unit-tested-and-never-called helper (the post-mortem is the comment block in
// test/starfield-depth-wiring.test.mjs), and a cull that is never called is simply the
// performance work not happening, silently, behind a green suite.
//
// AND ONE THING THE CULL CAN BREAK THAT THE PREDICATE CANNOT SEE. A star's streak is drawn
// from its PREVIOUS projected position to its current one. If the skip path returns before
// updating that previous position, then a star that wanders off the canvas and comes back
// draws its first visible streak from wherever it was when it left — a long wrong smear
// across the sky, appearing only for stars that re-enter, and only sometimes. The cull must
// skip the DRAWING and nothing else.

function makeGradient () {
  return { addColorStop () {} }
}

/** Records drawImage calls, which is what a cull is supposed to remove. */
function makeCtx (log) {
  const ctx = {
    _composite: 'source-over',
    _alpha: 1,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    createRadialGradient: () => makeGradient(),
    createLinearGradient: () => makeGradient(),
    fillRect () {}, clearRect () {}, stroke () {},
    beginPath () {}, arc () {}, fill () {},
    moveTo () {}, lineTo () {},
    save () {}, restore () {},
    translate () {}, rotate () {}, scale () {}, setTransform () {},
    drawImage (img, dx, dy, dw, dh) {
      // The sprite's own height tells the two draws apart: the glow sprite is 64x64, the
      // streak strip 64x4 (js/starfield.js). Needed because an off-canvas GLOW is legitimate
      // when the same star's streak is on-canvas — see the row below.
      log.push({ kind: img && img.height === 4 ? 'streak' : 'glow', dx, dy, dw, dh })
    }
  }
  Object.defineProperty(ctx, 'globalAlpha', {
    get () { return ctx._alpha }, set (v) { ctx._alpha = v }
  })
  Object.defineProperty(ctx, 'globalCompositeOperation', {
    get () { return ctx._composite }, set (v) { ctx._composite = v }
  })
  return ctx
}

function makeCanvas (log) {
  const ctx = makeCtx(log)
  return { width: 0, height: 0, getContext: () => ctx }
}

const VIEWPORT = { width: 1200, height: 800 }

async function bootNight (tag) {
  const log = []
  const mainCanvas = makeCanvas(log)
  let frameCb = null

  globalThis.document = {
    getElementById: () => mainCanvas,
    createElement: () => makeCanvas(log),
    addEventListener () {},
    visibilityState: 'visible',
    documentElement: {
      hasAttribute: (a) => a === 'data-time',
      dataset: { timeHours: '22' }
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

  const { initStarfield } = await import('../js/starfield.js?' + tag + '=' + Math.random())
  initStarfield('canvas', { getTheme: () => 'space' })
  assert.ok(frameCb, 'harness: the starfield must schedule a frame')
  log.length = 0
  return { log, pump: () => frameCb() }
}

test('nothing is drawn wholly outside the canvas', async () => {
  const { log, pump } = await bootNight('cull')
  for (let i = 0; i < 300; i++) pump()

  assert.ok(log.length > 0, 'harness: the frame must draw something, or this probe is blind')

  // Only the GLOW draws are judged by their box: the streak is drawn under a translate and
  // a rotate, so its logged dx/dy are in the rotated frame and mean nothing here.
  //
  // AND AN OFF-CANVAS GLOW IS NOT AUTOMATICALLY A MISS. The cull is per STAR, over the whole
  // comet: a star whose glow has just left the edge while its streak still crosses the
  // canvas MUST be drawn, and its glow drawImage is then a legitimate clipped no-op. So the
  // assertion is that every escaped glow belongs to a star that also drew a streak in the
  // same frame — which, because a star draws streak-then-glow, is the entry just before it.
  // A flat zero here is a test the correct implementation fails; it was, at 521 of 70,354.
  const pad = 2
  const isOff = (d) => d.dw > 0 && d.dh > 0 && (
    d.dx + d.dw < -pad || d.dx > VIEWPORT.width + pad
    || d.dy + d.dh < -pad || d.dy > VIEWPORT.height + pad
  )
  const unexplained = []
  for (let i = 0; i < log.length; i++) {
    const d = log[i]
    if (d.kind !== 'glow' || !isOff(d)) continue
    if (log[i - 1] && log[i - 1].kind === 'streak') continue
    unexplained.push(d)
  }
  assert.deepEqual(
    unexplained.slice(0, 5), [],
    `${unexplained.length} of ${log.length} draws were entirely off-canvas with no streak ` +
    'to justify them, across 300 frames. MEASURED before the cull: 36,474 of 143,894 draws ' +
    '(25%) at this viewport, 36% of stars at 1080p in the sandbox — every pixel of which ' +
    'the canvas clipped anyway. A number here is the cull not being called, which is the ' +
    'performance work silently not happening'
  )
})

test('a culled star still tracks its position, so its streak is never a stale smear', async () => {
  // The dangerous half. A star off the canvas keeps moving; when it comes back, its streak
  // is drawn from its previous projected position. If the skip path returns early without
  // updating that, the first visible streak runs from wherever it was when it left.
  const { log, pump } = await bootNight('cullprev')
  for (let i = 0; i < 400; i++) pump()

  // STREAK_MAX_DIST is 150 and the glow is clamped to STAR_MAX_RADIUS = 9, so no legitimate
  // draw is anywhere near the canvas diagonal. A stale-previous bug produces exactly that.
  const diagonal = Math.hypot(VIEWPORT.width, VIEWPORT.height)
  const absurd = log.filter((d) => Math.max(d.dw || 0, d.dh || 0) > diagonal / 2)
  assert.deepEqual(
    absurd.slice(0, 5), [],
    'a draw spanning half the canvas appeared. The streak is drawn from the star\'s ' +
    'PREVIOUS projected position: a cull that returns before updating it makes a ' +
    're-entering star smear from wherever it left. Skip the drawing, nothing else'
  )
})
