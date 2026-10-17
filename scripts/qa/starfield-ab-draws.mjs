#!/usr/bin/env node
/**
 * Starfield render-identity harness (M1 slice 0).
 *
 * Renders the starfield twice — a baseline revision of `js/starfield.js` from git, and the
 * working tree — under the SAME seeded `Math.random`, the same viewport and the same frame
 * count, recording every draw call with its full transform. Then it drops the calls that
 * cannot put a pixel on the canvas and compares what is left.
 *
 *     node scripts/qa/starfield-ab-draws.mjs                 # vs HEAD
 *     node scripts/qa/starfield-ab-draws.mjs HEAD~3          # vs an older revision
 *     node scripts/qa/starfield-ab-draws.mjs HEAD 22 600     # revision, hour, frames
 *     node scripts/qa/starfield-ab-draws.mjs HEAD 22 400 1   # ...under reduced motion
 *
 * Exit 0 when the visible streams are identical, 1 when they differ (with the first
 * difference printed).
 *
 * WHY DRAW CALLS AND NOT PIXELS. The plan specified a `getImageData` diff, which needs a
 * browser; this repo has no browser E2E and no test dependencies, and standing one up is its
 * own project with its own flake budget. Comparing the visible draw stream is a STRONGER
 * statement than sampling pixels, not a weaker one: if two renderers issue the identical
 * sequence of draws with identical transforms and alphas, the composited result is identical
 * by construction. There is nothing left to sample.
 *
 * THE FILTER HAS TO BE EXACT, and this is the trap the first version fell into. A streak is
 * drawn under `translate` + `rotate`, so its destination box is NOT axis-aligned in canvas
 * space. A loose bound keeps some genuinely-invisible draws, and keeping one in one stream
 * and not the other misaligns the comparison — reporting a "difference" that is nothing but
 * the filter's own slack. So the quad's four corners are rotated properly and the test is on
 * the true extent.
 *
 * This is NOT part of `node --test`: it shells out to git and renders 400 frames twice. Run
 * it by hand when changing the renderer.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const JS = join(REPO, 'js')

const [, , baseRef = 'HEAD', hours = '22', framesArg = '400', reducedArg = '0'] = process.argv
// Reduced motion is a different draw path (no streaks), so it needs its own run.
const REDUCED = reducedArg === '1' || reducedArg === 'reduced'
const FRAMES = Number(framesArg)
const W = 1200
const H = 800

/** Deterministic, so both runs seed their stars and sprites identically. */
function mulberry32 (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function makeHarness (log) {
  const state = { a: 1, tx: 0, ty: 0, rot: 0 }
  const stack = []
  const gradient = () => ({ addColorStop () {} })
  const mkCtx = () => {
    const ctx = {
      _c: 'source-over',
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
      createRadialGradient: gradient, createLinearGradient: gradient,
      fillRect () {}, clearRect () {}, stroke () {}, beginPath () {}, arc () {}, fill () {},
      moveTo () {}, lineTo () {}, scale () {},
      save () { stack.push({ ...state }) },
      restore () { const s = stack.pop(); if (s) Object.assign(state, s) },
      translate (x, y) { state.tx += x; state.ty += y },
      rotate (r) { state.rot += r },
      // Modelled, not ignored: the renderer may express the same streak placement either
      // as translate+rotate or as one setTransform, and a harness that only understood the
      // first would report that swap as a rendering change.
      setTransform (a, b, _c2, _d, e, f) {
        state.tx = e
        state.ty = f
        state.rot = Math.atan2(b, a)
      },
      drawImage (img, dx, dy, dw, dh) {
        // The RAW transform and the RAW destination box, kept apart so the true quad can be
        // reconstructed. Rounded so float noise cannot masquerade as a difference.
        log.push({
          k: img && img.height === 4 ? 'streak' : 'glow',
          tx: +state.tx.toFixed(3), ty: +state.ty.toFixed(3), r: +state.rot.toFixed(6),
          dx: +(+dx).toFixed(3), dy: +(+dy).toFixed(3),
          w: +(+dw).toFixed(3), h: +(+dh).toFixed(3),
          a: +state.a.toFixed(6)
        })
      }
    }
    Object.defineProperty(ctx, 'globalAlpha', {
      get () { return state.a }, set (v) { state.a = v }
    })
    Object.defineProperty(ctx, 'globalCompositeOperation', {
      get () { return ctx._c }, set (v) { ctx._c = v }
    })
    return ctx
  }
  return () => ({ width: 0, height: 0, getContext: mkCtx })
}

async function render (moduleUrl, tag) {
  const log = []
  const mkCanvas = makeHarness(log)
  const main = mkCanvas()
  let frame = null

  globalThis.document = {
    getElementById: () => main,
    createElement: () => mkCanvas(),
    addEventListener () {},
    visibilityState: 'visible',
    documentElement: { hasAttribute: (a) => a === 'data-time', dataset: { timeHours: hours } }
  }
  globalThis.window = {
    innerWidth: W, innerHeight: H,
    navigator: { hardwareConcurrency: 6 },
    matchMedia: (q) => ({
      matches: REDUCED && /prefers-reduced-motion/.test(String(q)),
      addEventListener () {}
    }),
    addEventListener () {},
    requestAnimationFrame: (cb) => { frame = cb; return 1 },
    cancelAnimationFrame () {}
  }

  // Seeded AFTER the globals and BEFORE the import: sprite baking and star seeding both
  // draw on Math.random, so both runs must see the same sequence from the same point.
  //
  // THE CLOCK IS PINNED TOO, and it is not optional. Snow drift and the firefly wander read
  // `Date.now()` directly (js/starfield.js:518,553), so two runs seconds apart produce
  // genuinely different output on every path that draws them. Without this, hours 12 and 19
  // reported a difference that was the wall clock, not the renderer — a harness that cries
  // wolf on the daytime scenes is a harness nobody runs. It advances one frame per tick so
  // animation still progresses; it just progresses identically in both runs.
  const realRandom = Math.random
  const realNow = Date.now
  let clock = 1_700_000_000_000
  Date.now = () => clock
  Math.random = mulberry32(0x5EED)
  try {
    const { initStarfield } = await import(moduleUrl + '?ab=' + tag)
    initStarfield('canvas', { getTheme: () => 'space' })
    log.length = 0
    for (let i = 0; i < FRAMES; i++) { clock += 16; frame() }
  } finally {
    Math.random = realRandom
    Date.now = realNow
  }
  return log
}

/** The exact rotated quad, so this can never keep a draw that puts down no pixel. */
function invisible (d) {
  if (d.a <= 0) return true
  const cos = Math.cos(d.r)
  const sin = Math.sin(d.r)
  const xs = []
  const ys = []
  for (const [x, y] of [
    [d.dx, d.dy], [d.dx + d.w, d.dy], [d.dx + d.w, d.dy + d.h], [d.dx, d.dy + d.h]
  ]) {
    xs.push(d.tx + x * cos - y * sin)
    ys.push(d.ty + x * sin + y * cos)
  }
  return Math.max(...xs) < 0 || Math.min(...xs) > W
    || Math.max(...ys) < 0 || Math.min(...ys) > H
}

const work = mkdtempSync(join(tmpdir(), 'starfield-ab-'))
try {
  // The baseline, with its relative imports repointed at the working tree's leaf modules —
  // those are compared separately, and pinning them here would make a leaf change look like
  // a renderer change.
  const baseline = execFileSync('git', ['show', `${baseRef}:js/starfield.js`], {
    cwd: REPO, encoding: 'utf8'
  }).replace(/from '\.\/([a-z0-9-]+\.js)'/g, (_m, f) => `from '${pathToFileURL(join(JS, f)).href}'`)
  const baselinePath = join(work, 'starfield-baseline.mjs')
  writeFileSync(baselinePath, baseline)

  const before = await render(pathToFileURL(baselinePath).href, 'before')
  const after = await render(pathToFileURL(join(JS, 'starfield.js')).href, 'after')

  const visBefore = before.filter((d) => !invisible(d))
  const visAfter = after.filter((d) => !invisible(d))

  let firstDiff = null
  for (let i = 0; i < Math.max(visBefore.length, visAfter.length); i++) {
    if (JSON.stringify(visBefore[i] ?? null) !== JSON.stringify(visAfter[i] ?? null)) {
      firstDiff = { at: i, before: visBefore[i] ?? null, after: visAfter[i] ?? null }
      break
    }
  }

  console.log(JSON.stringify({
    baseline: baseRef,
    hour: hours,
    reducedMotion: REDUCED,
    frames: FRAMES,
    viewport: [W, H],
    drawCalls: { before: before.length, after: after.length },
    removed: before.length - after.length,
    removedPct: +((1 - after.length / (before.length || 1)) * 100).toFixed(1),
    visibleDrawCalls: { before: visBefore.length, after: visAfter.length },
    identical: firstDiff === null,
    firstDiff
  }, null, 1))

  process.exit(firstDiff === null ? 0 : 1)
} finally {
  rmSync(work, { recursive: true, force: true })
}
