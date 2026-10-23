import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { bootDaytime } from './fixtures/daytime-starfield.mjs'

// Is the decision WIRED, and does the renderer stay ignorant of why? (ADR-0016 §3)
//
// `test/precipitation.test.mjs` asserts the leaf. This asserts the seam — and it is the
// slice that stops M3 being a defined-but-never-called helper, which is a failure this repo
// has already shipped once behind a green suite (the post-mortem is the comment block in
// test/starfield-depth-wiring.test.mjs).
//
// AND IT IS THE FIRST TEST IN THIS REPO TO BOOT THE STARFIELD AT A DAYTIME HOUR. Every
// existing stub-canvas test uses '22'. The branch M3 rewrites has had zero wiring coverage
// up to now, which is worth saying out loud rather than discovering later.

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')

test('an absent or nonsense attribute falls back rather than drawing nothing', async () => {
  // A blank daytime sky is indistinguishable from a dead renderer, which is the asymmetry
  // the cull argument already turns on. FALLBACK_KIND is rain.
  for (const value of [undefined, 'sleet', '']) {
    const { log, pump } = await bootDaytime('precip-fallback' + String(value), value)
    for (let i = 0; i < 3; i++) pump()
    assert.ok(
      log.length > 0,
      `data-precipitation=${JSON.stringify(value)} produced an EMPTY daytime sky, which ` +
      'reads as a dead renderer rather than as a missing attribute'
    )
  }
})

test('the renderer knows a kind string, and nothing about why', () => {
  // The fence (§3.3). js/starfield.js may know a kind, counts and scene weights. It may not
  // know about months, dates, hemispheres, timezones or hail odds — and the reason is
  // MEASURED rather than architectural taste: scripts/qa/starfield-ab-draws.mjs fakes
  // Date.now, and `new Date()` does not consult Date.now. A calendar read inside the
  // renderer is therefore invisible to the harness's clock pin, and the harness would start
  // producing different answers depending on what day you ran it.
  const src = read('js', 'starfield.js')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  for (const forbidden of ['new Date(', 'getMonth', 'getFullYear', 'getDate(', 'Intl.']) {
    assert.ok(
      !code.includes(forbidden),
      `js/starfield.js contains ${forbidden}. The renderer must not read the calendar: the ` +
      'A/B harness pins Date.now and `new Date()` bypasses it, so this is the difference ' +
      'between a harness that is a gate and one that cries wolf on the daytime scenes'
    )
  }
  assert.doesNotMatch(
    code, /from '\.\/precipitation\.js'/,
    'js/starfield.js must not import the decision leaf — it reads the attribute, which is ' +
    'what makes the QA override one line in a devtools console'
  )
})

test('js/theme.js writes the attribute, and only when it changes', () => {
  const src = read('js', 'theme.js')
  assert.match(
    src, /dataset\.precipitation/,
    'js/theme.js must write data-precipitation. It already owns the clock and already ' +
    'writes dataset.timeHours for the renderer to read per frame — this is that pattern, ' +
    'not a new one'
  )
  assert.match(
    src, /precipitationFor/,
    'and it must get the kind from the leaf rather than deciding anything itself'
  )
  // applyThemeTime runs at boot, once a minute on the auto tick, and on EVERY slider input.
  // Writing unconditionally would thrash the DOM through a drag.
  assert.match(
    src, /!==\s*kind|kind\s*!==|dataset\.precipitation\s*!==/,
    'the write must be guarded by a comparison, so a slider drag does not rewrite the ' +
    'attribute on every input event'
  )
})
