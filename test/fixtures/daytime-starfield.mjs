import assert from 'node:assert/strict'

// Boot the starfield at NOON, with a precipitation kind pinned on the root.
//
// THE FIRST DAYTIME STARFIELD HARNESS IN THIS REPO. Every existing stub-canvas test boots
// at hour '22', so the branch M3 rewrites had zero wiring coverage before this. Shared by
// the seam test and the render test so the two cannot drift into booting slightly different
// pages and then disagreeing about why.
//
// The context records STROKES as well as drawImage calls, because rain is a batched stroke
// pass and emits no sprites at all — a stub that only counted drawImage would record a
// working rain renderer and a deleted one identically. (The A/B harness needed the same
// correction, for the same reason.)

function makeGradient () {
  return { addColorStop () {} }
}

function makeCtx (log) {
  const ctx = {
    _c: 'source-over', _a: 1,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    createRadialGradient (...a) { log.push({ kind: 'radialGradient' }); void a; return makeGradient() },
    createLinearGradient (...a) { log.push({ kind: 'linearGradient' }); void a; return makeGradient() },
    fillRect () {}, clearRect () {}, beginPath () {}, arc () {}, fill () {},
    moveTo () {}, lineTo () {}, stroke () { log.push({ kind: 'stroke' }) },
    save () {}, restore () {}, translate () {}, rotate () {}, scale () {}, setTransform () {},
    drawImage (img) { log.push({ kind: 'drawImage', spriteHeight: img && img.height }) }
  }
  Object.defineProperty(ctx, 'globalAlpha', { get () { return ctx._a }, set (v) { ctx._a = v } })
  Object.defineProperty(ctx, 'globalCompositeOperation', {
    get () { return ctx._c }, set (v) { ctx._c = v }
  })
  return ctx
}

const makeCanvas = (log) => ({ width: 0, height: 0, getContext: () => makeCtx(log) })

async function bootDaytime (tag, precipitation) {
  const log = []
  const main = makeCanvas(log)
  let frame = null
  const dataset = { timeHours: '12' }
  if (precipitation) dataset.precipitation = precipitation

  globalThis.document = {
    getElementById: () => main,
    createElement: () => makeCanvas(log),
    addEventListener () {},
    visibilityState: 'visible',
    documentElement: {
      hasAttribute: (a) => a === 'data-time' || (a === 'data-precipitation' && Boolean(precipitation)),
      dataset
    }
  }
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    navigator: { hardwareConcurrency: 6 },
    matchMedia: () => ({ matches: false, addEventListener () {} }),
    addEventListener () {},
    requestAnimationFrame: (cb) => { frame = cb; return 1 },
    cancelAnimationFrame () {}
  }

  const { initStarfield } = await import('../../js/starfield.js?' + tag + '=' + Math.random())
  initStarfield('canvas', { getTheme: () => 'garden' })
  assert.ok(frame, 'harness: the starfield must schedule a frame')
  log.length = 0
  return { log, pump: () => frame(), dataset }
}

export { makeCanvas, bootDaytime }
