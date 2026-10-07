// WHY — wiring the dust GC into the real night frame, without moving a single pixel of prod.
//
// The pure seams (alphaStalls / dustAlphaFloor / sweepBandRect / nextSweepCursor /
// collectDust) are already green in starfield-dust-gc.test.mjs, but nothing calls them.
// This pins the WIRING contract by driving the REAL initStarfield against a stub DOM.
//
// Two things must be true at once, and the second is the one that got a previous attempt
// rejected outright:
//   1. every night frame sweeps ONE band of real pixels and zeroes the stuck ones, and
//   2. prod's LOOK is byte-for-byte unchanged — the night path still erases with
//      globalCompositeOperation 'destination-out' at rgba(0, 0, 0, 0.22), and the canvas
//      never grows a mixBlendMode (screen blending changed the render; the navigator said no).
//
// The sweep must land BEFORE the fade fillRect: sweeping first means the faint star halos
// drawn later this frame — legitimately below the floor — are never clipped from the frame
// the viewer actually sees.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DUST_SWEEP_ROWS, initStarfield } from '../js/starfield.js'

const CANVAS_W = 400
const CANVAS_H = 300
const STUCK_ALPHA = 2 // the fade's fixed point: round(2 * 0.78) === 2, forever

/** A 2d context that records the ops the look/GC contract cares about. */
function recordingContext (ops) {
  const state = { fillStyle: '', globalCompositeOperation: 'source-over' }
  const gradient = { addColorStop () {} }
  return {
    get fillStyle () { return state.fillStyle },
    set fillStyle (v) { state.fillStyle = v },
    get globalCompositeOperation () { return state.globalCompositeOperation },
    set globalCompositeOperation (v) { state.globalCompositeOperation = v },
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    save () {},
    restore () {},
    beginPath () {},
    moveTo () {},
    lineTo () {},
    stroke () {},
    arc () {},
    fill () {},
    drawImage () {},
    createLinearGradient () { return gradient },
    createRadialGradient () { return gradient },
    fillRect (x, y, w, h) {
      ops.push({
        op: 'fillRect',
        x,
        y,
        w,
        h,
        fillStyle: state.fillStyle,
        composite: state.globalCompositeOperation
      })
    },
    clearRect (x, y, w, h) {
      ops.push({ op: 'clearRect', x, y, w, h })
    },
    getImageData (x, y, w, h) {
      // Seed EVERY pixel as stuck dust: non-zero rgb + the alpha the fade can never clear.
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 40
        data[i + 1] = 60
        data[i + 2] = 80
        data[i + 3] = STUCK_ALPHA
      }
      const img = { data, width: w, height: h }
      ops.push({ op: 'getImageData', x, y, w, h, img })
      return img
    },
    putImageData (img, x, y) {
      ops.push({ op: 'putImageData', img, x, y })
    }
  }
}

/**
 * Stand up a stub window/document and start the real starfield in living-time mode.
 * initStarfield reads matchMedia ONCE at init, so reducedMotion is fixed per harness.
 */
function startStarfield ({ timeHours, reducedMotion = false }) {
  const ops = []
  const frames = []
  const canvas = {
    id: 'starfield',
    width: CANVAS_W,
    height: CANVAS_H,
    style: {},
    getContext: () => recordingContext(ops)
  }

  globalThis.window = {
    innerWidth: CANVAS_W,
    innerHeight: CANVAS_H,
    navigator: { hardwareConcurrency: 4 },
    matchMedia: () => ({ matches: reducedMotion, addEventListener () {} }),
    addEventListener () {},
    requestAnimationFrame (cb) { frames.push(cb); return frames.length },
    cancelAnimationFrame () {}
  }

  globalThis.document = {
    visibilityState: 'visible',
    documentElement: {
      dataset: { timeHours: String(timeHours) },
      hasAttribute: (name) => name === 'data-time'
    },
    getElementById: (id) => (id === 'starfield' ? canvas : null),
    createElement: () => ({
      width: 0,
      height: 0,
      style: {},
      getContext: () => recordingContext([])
    }),
    addEventListener () {}
  }

  initStarfield('starfield')

  /** Run one scheduled rAF callback and return only the ops it recorded. */
  const step = () => {
    const before = ops.length
    const cb = frames.shift()
    cb(performance.now())
    return ops.slice(before)
  }

  return { canvas, step }
}

// One frame proves the band is swept; it cannot prove the band MOVES. Deleting the cursor
// advance, or writing the band back to the wrong row, both survive a single-frame test —
// and either bug means dust is never collected (or the canvas is smeared). Drive more than
// a full cycle and pin the cursor's trajectory: it steps by DUST_SWEEP_ROWS, wraps to 0,
// covers every row exactly once per cycle, and each write lands where its read came from.
test('the sweep cursor walks the whole canvas and writes each band back where it was read', () => {
  // Arrange — deep night, full motion. A cycle is ceil(CANVAS_H / DUST_SWEEP_ROWS) frames.
  const { step } = startStarfield({ timeHours: 1 })
  const perCycle = Math.ceil(CANVAS_H / DUST_SWEEP_ROWS)

  // Act — run more than two full cycles, pairing each read with the write it produced.
  const reads = []
  const writes = []
  for (let frame = 0; frame < perCycle * 2 + 3; frame++) {
    const frameOps = step()
    for (const o of frameOps) {
      if (o.op === 'getImageData') reads.push(o)
      if (o.op === 'putImageData') writes.push(o)
    }
  }

  // Assert — the cursor advances by the band height and wraps back to the top.
  const ys = reads.map((r) => r.y)
  const expectedFirstCycle = Array.from({ length: perCycle }, (_, i) => i * DUST_SWEEP_ROWS)
  assert.deepEqual(ys.slice(0, perCycle), expectedFirstCycle, 'the cursor advances one band per frame')
  assert.equal(ys[perCycle], 0, 'the cursor wraps to the top after a full cycle')
  assert.deepEqual(ys.slice(perCycle, perCycle * 2), expectedFirstCycle, 'and cycles again')

  // ...and one cycle leaves NO ROW uncollected: every row swept exactly once.
  const covered = new Array(CANVAS_H).fill(0)
  for (const r of reads.slice(0, perCycle)) {
    for (let y = r.y; y < r.y + r.h; y++) covered[y]++
  }
  assert.deepEqual(covered, new Array(CANVAS_H).fill(1), 'one cycle covers every row exactly once')

  // ...and every collected band is written back to the exact rect it was read from.
  assert.equal(writes.length, reads.length, 'every read band is written back')
  for (let i = 0; i < reads.length; i++) {
    assert.equal(writes[i].x, reads[i].x, `band ${i} written back to the wrong column`)
    assert.equal(writes[i].y, reads[i].y, `band ${i} written back to the wrong row`)
  }
})

test('each night frame sweeps one dust band before the prod destination-out fade', () => {
  // Arrange — deep night (sceneParamsAt(1): star 1, sun 0), full motion.
  const { canvas, step } = startStarfield({ timeHours: 1 })

  // Act — one real animation frame.
  const frameOps = step()

  // Assert — the collector ran on real pixels: exactly one readback of one full-width band.
  const reads = frameOps.filter((o) => o.op === 'getImageData')
  const writes = frameOps.filter((o) => o.op === 'putImageData')
  assert.equal(reads.length, 1, 'a night frame reads back exactly one dust band')
  assert.equal(writes.length, 1, 'a night frame writes back exactly one dust band')
  assert.equal(reads[0].x, 0)
  assert.equal(reads[0].w, CANVAS_W)
  assert.equal(reads[0].h, DUST_SWEEP_ROWS)

  // ...and it actually collected: every seeded stuck pixel comes back zeroed.
  const alphas = new Set()
  for (let i = 3; i < writes[0].img.data.length; i += 4) alphas.add(writes[0].img.data[i])
  assert.deepEqual([...alphas], [0], 'stuck pixels are zeroed before being written back')

  // The look guard: prod's fade is untouched, and nothing switched to blend compositing.
  const fade = frameOps.find(
    (o) => o.op === 'fillRect' && o.w === CANVAS_W && o.h === CANVAS_H
  )
  assert.equal(fade.composite, 'destination-out')
  assert.equal(fade.fillStyle, 'rgba(0, 0, 0, 0.22)')
  assert.equal(canvas.style.mixBlendMode, undefined, 'the canvas never gets a blend mode')

  // The sweep lands before the fade, so this frame's faint halos are never clipped.
  assert.ok(
    frameOps.indexOf(writes[0]) < frameOps.indexOf(fade),
    'the dust sweep runs before the frame is painted'
  )
})
