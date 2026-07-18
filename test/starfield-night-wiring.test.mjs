// WIRING contract for the living-theme NIGHT render path (js/starfield.js
// drawTime, night branch). The bug: night fades the trail with
// globalCompositeOperation='destination-out' + fillRect rgba(0,0,0,0.22); 8-bit
// alpha ROUNDS at the bottom so trails stall at alpha 2 forever (a permanent,
// growing veil). The fix (curve pinned in starfield-trail.test.mjs): the canvas
// carries an OPAQUE-BLACK base, faded on the COLOUR channel with source-over
// rgba(0,0,0,0.22) (8-bit colour TRUNCATES → reaches 0), and the canvas element
// gets CSS mix-blend-mode 'screen' (black = identity, so the CSS sky shows
// through). This test drives the REAL initStarfield through a recording 2d
// stub and steps night frames by hand to pin that render contract.

import test from 'node:test'
import assert from 'node:assert/strict'

// ── DOM stubs (installed on globalThis before importing starfield.js) ─────────

// A 2d context that RECORDS every drawing op with the compositing state at the
// moment of the call, so the test can inspect what the night path actually drew.
function makeRecordingCtx() {
  const ops = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    createRadialGradient() {
      return { addColorStop() {} }
    },
    createLinearGradient() {
      return { addColorStop() {} }
    }
  }
  const record = (op, args) =>
    ops.push({ op, fillStyle: ctx.fillStyle, composite: ctx.globalCompositeOperation, args })
  for (const op of [
    'fillRect', 'clearRect', 'save', 'restore', 'beginPath', 'arc',
    'fill', 'stroke', 'moveTo', 'lineTo', 'drawImage'
  ]) {
    ctx[op] = (...args) => record(op, args)
  }
  ctx.__ops = ops
  return ctx
}

// Sprite canvases (snow + firefly) only need to not throw during setup.
function makeSpriteCanvas() {
  const noopCtx = {
    fillStyle: '',
    createRadialGradient() {
      return { addColorStop() {} }
    },
    createLinearGradient() {
      return { addColorStop() {} }
    }
  }
  for (const op of ['beginPath', 'arc', 'fill', 'fillRect', 'drawImage']) noopCtx[op] = () => {}
  return { width: 0, height: 0, style: {}, getContext: () => noopCtx }
}

const mainCtx = makeRecordingCtx()
const mainCanvas = { width: 0, height: 0, style: {}, getContext: () => mainCtx }

const documentStub = {
  documentElement: {
    dataset: { timeHours: '1' },
    hasAttribute: (name) => name === 'data-time'
  },
  visibilityState: 'visible',
  getElementById: (id) => (id === 'canvas' ? mainCanvas : null),
  createElement: () => makeSpriteCanvas(),
  addEventListener: () => {}
}

let rafCb = null
let nextRafId = 0
// Flipped per test; initStarfield reads it once at init via matchMedia.
let reducedMotion = false
const windowStub = {
  innerWidth: 800,
  innerHeight: 600,
  navigator: { hardwareConcurrency: 4 },
  matchMedia: () => ({ matches: reducedMotion, addEventListener: () => {} }),
  addEventListener: () => {},
  requestAnimationFrame: (cb) => {
    rafCb = cb
    return ++nextRafId
  },
  cancelAnimationFrame: () => {}
}

globalThis.document = documentStub
globalThis.window = windowStub

const { initStarfield, TRAIL_FADE_ALPHA } = await import('../js/starfield.js')

// Invoke the single frame the animation loop has scheduled; each frame
// re-registers the next one, so calling step() advances exactly one frame.
function step() {
  const cb = rafCb
  rafCb = null
  assert.equal(typeof cb, 'function', 'a frame should be scheduled')
  cb()
}

// ── Matchers over recorded ops ───────────────────────────────────────────────
const isFullCanvasFill = (s) =>
  s.op === 'fillRect' &&
  s.args[0] === 0 && s.args[1] === 0 &&
  s.args[2] === mainCanvas.width && s.args[3] === mainCanvas.height
const isFullCanvasClear = (s) =>
  s.op === 'clearRect' &&
  s.args[0] === 0 && s.args[1] === 0 &&
  s.args[2] === mainCanvas.width && s.args[3] === mainCanvas.height
const isOpaqueBlack = (v) =>
  typeof v === 'string' && /^(#000|#000000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(v)
// Keyed off the exported constant so this matcher moves with the prod curve
// (starfield-trail.test.mjs pins the constant's VALUE).
const isColourFade = (v) => v === `rgba(0, 0, 0, ${TRAIL_FADE_ALPHA})`
const isFullErase = (v) => v === 'rgba(0, 0, 0, 1)'

test('a night frame holds its trail with a faded opaque-black base screened over the sky, never a destination-out erase', () => {
  // Arrange: deep-night living theme (hour 1 → sceneParamsAt(1) star=1, sun=0,
  // firefly=0), so drawTime takes the night branch.
  documentStub.documentElement.dataset.timeHours = '1'
  initStarfield('canvas', {})

  // Act: render three night frames, capturing each frame's ops.
  const f1 = mainCtx.__ops.length
  step()
  const frame1 = mainCtx.__ops.slice(f1)
  const f2 = mainCtx.__ops.length
  step()
  const frame2 = mainCtx.__ops.slice(f2)
  const f3 = mainCtx.__ops.length
  step()
  const frame3 = mainCtx.__ops.slice(f3)
  const nightOps = mainCtx.__ops.slice(f1)

  // Assert (facets of the one night-render contract):
  // 1. never erases with destination-out (removes the alpha-rounding veil bug).
  assert.ok(
    !nightOps.some((s) => s.composite === 'destination-out'),
    'night must never composite with destination-out'
  )

  // 2. paints exactly one opaque-black base across the run — the layer that
  // holds the trail; repainting it per frame would erase what it exists to keep.
  const opaqueBases = nightOps.filter(
    (s) => isFullCanvasFill(s) && s.composite === 'source-over' && isOpaqueBlack(s.fillStyle)
  )
  assert.equal(opaqueBases.length, 1, 'night paints exactly one opaque-black base')

  // 3. every night frame fades the COLOUR channel with the prod curve (0.22)
  // under source-over — that is what decays the trail to zero.
  assert.ok(
    frame1.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isColourFade(s.fillStyle)),
    'frame 1 fades the colour with the prod curve'
  )
  assert.ok(
    frame2.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isColourFade(s.fillStyle)),
    'frame 2 fades the colour with the prod curve'
  )
  assert.ok(
    frame3.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isColourFade(s.fillStyle)),
    'frame 3 fades the colour with the prod curve'
  )

  // 4. the canvas element is screened onto the CSS sky (black = identity).
  assert.equal(mainCanvas.style.mixBlendMode, 'screen', 'night screens the canvas onto the sky')
})

test('crossing dusk and back: day restores normal compositing, night re-primes its base once', () => {
  // Arrange: one init deep in night (hour 1 → star=1, sun=0), establish the
  // night state test 1 already pins (base painted once, trail fading), then walk
  // the clock across to day and back — stepping frames by hand. This pins the
  // TRANSITION half of the contract test 1 held back: leaving night must restore
  // NORMAL compositing (snow must alpha-composite over the garden; 'screen' would
  // blow it out to white), and RE-entering night must re-prime the opaque base
  // exactly once — on entry, not per frame (per-frame would erase the trail).
  documentStub.documentElement.dataset.timeHours = '1'
  initStarfield('canvas', {})
  step()
  step()

  // Act 1 — cross to day (noon: sun=1, star=0) and render one frame.
  documentStub.documentElement.dataset.timeHours = '12'
  const d = mainCtx.__ops.length
  step()
  const dayFrame = mainCtx.__ops.slice(d)

  // Assert: day composites normally, fully clears the frame, and paints neither
  // the night base nor the night fade.
  assert.equal(
    mainCanvas.style.mixBlendMode, 'normal',
    'day composites the snow normally over the garden (screen would blow it out to white)'
  )
  assert.ok(dayFrame.some(isFullCanvasClear), 'day fully clears the frame')
  assert.ok(
    !dayFrame.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isOpaqueBlack(s.fillStyle)),
    'day never paints the opaque-black night base'
  )
  assert.ok(
    !dayFrame.some((s) => isFullCanvasFill(s) && isColourFade(s.fillStyle)),
    'day never paints the night colour fade'
  )

  // Act 2 — cross back to night (hour 1) and render two frames.
  documentStub.documentElement.dataset.timeHours = '1'
  const n = mainCtx.__ops.length
  step()
  const nightFrame1 = mainCtx.__ops.slice(n)
  const n2 = mainCtx.__ops.length
  step()
  const nightFrame2 = mainCtx.__ops.slice(n2)
  const reentryOps = mainCtx.__ops.slice(n)

  // Assert: night re-screens the canvas, re-primes the opaque base EXACTLY once
  // across the two re-entry frames (on entry only), and fades both frames.
  assert.equal(mainCanvas.style.mixBlendMode, 'screen', 'night screens the canvas onto the sky again')
  const reprimes = reentryOps.filter(
    (s) => isFullCanvasFill(s) && s.composite === 'source-over' && isOpaqueBlack(s.fillStyle)
  )
  assert.equal(reprimes.length, 1, 'night re-primes the opaque-black base exactly once on re-entry')
  assert.ok(
    nightFrame1.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isColourFade(s.fillStyle)),
    're-entry frame 1 fades the colour with the prod curve'
  )
  assert.ok(
    nightFrame2.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isColourFade(s.fillStyle)),
    're-entry frame 2 fades the colour with the prod curve'
  )
})

test('reduced motion at night: the frame is erased outright — no trail ever accumulates', () => {
  // Invariant #6 (a11y): reduced-motion users get stars, never a trail. The
  // architecture still applies (opaque base, screen blend) — only the fade is a
  // FULL black repaint (trailFadeAlpha(true) === 1), a total erase of the
  // previous frame, so nothing can accumulate between frames.
  reducedMotion = true
  try {
    documentStub.documentElement.dataset.timeHours = '1'
    initStarfield('canvas', {})

    const f1 = mainCtx.__ops.length
    step()
    const frame1 = mainCtx.__ops.slice(f1)
    const f2 = mainCtx.__ops.length
    step()
    const frame2 = mainCtx.__ops.slice(f2)

    assert.ok(
      frame1.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isFullErase(s.fillStyle)),
      'reduced-motion frame 1 repaints fully black — a total erase'
    )
    assert.ok(
      frame2.some((s) => isFullCanvasFill(s) && s.composite === 'source-over' && isFullErase(s.fillStyle)),
      'reduced-motion frame 2 repaints fully black — a total erase'
    )
    assert.ok(
      !mainCtx.__ops.slice(f1).some((s) => s.composite === 'destination-out'),
      'reduced motion never composites with destination-out either'
    )
    assert.equal(
      mainCanvas.style.mixBlendMode, 'screen',
      'the screen architecture still applies; only the fade alpha differs'
    )
  } finally {
    reducedMotion = false
  }
})
