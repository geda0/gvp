import test from 'node:test'
import assert from 'node:assert/strict'

import { bootDaytime } from './fixtures/daytime-starfield.mjs'

// Does the renderer actually draw a DIFFERENT sky per kind? (ADR-0016 §4.3)
//
// Split from test/precipitation-wiring.test.mjs on the slice boundary: that file owns the
// SEAM (js/theme.js writes the attribute, js/starfield.js stays ignorant of the calendar),
// which lands before any rain is drawn. This file owns what the renderer does with the kind
// once it has one, and it is red until the rain and hail slices land — which is the honest
// place for it, rather than leaving a known-red row in the seam's own file.

test('the renderer honours data-precipitation — snow, rain and hail draw differently', async () => {
  const seen = {}
  for (const kind of ['snow', 'rain', 'hail']) {
    const { log, pump } = await bootDaytime('precip-' + kind, kind)
    for (let i = 0; i < 3; i++) pump()
    seen[kind] = {
      draws: log.filter((d) => d.kind === 'drawImage').length,
      strokes: log.filter((d) => d.kind === 'stroke').length,
      spriteHeights: [...new Set(log.map((d) => d.spriteHeight).filter(Boolean))]
    }
  }

  assert.ok(
    seen.snow.draws > 0,
    'snow must still draw its sprites — this is the shipped daytime look and nothing about ' +
    `adding rain may change it. Saw ${JSON.stringify(seen.snow)}`
  )
  assert.ok(
    seen.rain.strokes > 0,
    'rain is a batched stroke pass, so it emits strokes rather than drawImage calls. Zero ' +
    `means the attribute is being read and ignored, or not read at all. Saw ${JSON.stringify(seen.rain)}`
  )
  assert.ok(
    seen.hail.draws > 0,
    `hail draws pellets. Saw ${JSON.stringify(seen.hail)}`
  )
  assert.notDeepEqual(
    seen.snow, seen.rain,
    'snow and rain produced the same draw profile, so the kind is not reaching the renderer'
  )
  assert.notDeepEqual(seen.rain, seen.hail)
})

test('no kind allocates a gradient per frame', async () => {
  // test/starfield-perf.test.mjs pins createRadialGradient === 0 and createLinearGradient
  // === 0 on a drawing frame — but it runs ONLY at hour 22, so the daytime branch M3
  // rewrites has never been covered by it. ADR-0016 §10.5 flags that gap; this is the
  // daytime variant.
  //
  // It is what forces rain to be a SOLID stroke colour rather than a per-drop linear
  // gradient, and what makes the hail pellet a sprite baked once at init rather than a
  // gradient per pellet per frame — the same trick the snowflake already uses, and the one
  // M1 spent a slice establishing for stars.
  for (const kind of ['snow', 'rain', 'hail']) {
    const { log, pump } = await bootDaytime('precip-grad-' + kind, kind)
    for (let i = 0; i < 3; i++) pump()
    const gradients = log.filter((d) => d.kind.endsWith('Gradient'))
    assert.equal(
      gradients.length, 0,
      `${kind} allocated ${gradients.length} gradients across three frames. Bake it into a ` +
      'sprite at init, or use a solid colour'
    )
  }
})
