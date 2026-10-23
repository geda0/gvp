// Star pace and frame pacing (owner, 2026-10-23: "slow them down a notch ... showing
// inconsistency based on the resources and the machine capabilities"). The renderer wiring is
// pinned in test/starfield-night.test.mjs; this pins the arithmetic it relies on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { frameStep, REFERENCE_FRAME_MS, MAX_FRAME_STEP, STAR_PACE } from '../js/starfield-prefs.js'

test('frames faster than the reference rate are skipped; 60Hz frames step exactly once', () => {
  assert.equal(frameStep(1000 / 120), 0)
  assert.equal(frameStep(1000 / 144), 0)
  assert.equal(frameStep(1000 / 60), 1)
  assert.equal(frameStep(15.5), 1, 'vsync jitter around 16.7ms still draws, without slowing the sky')
})

test('slower frames step by the real elapsed time, so the sky keeps its speed on a loaded machine', () => {
  assert.equal(frameStep(2 * REFERENCE_FRAME_MS), 2)
  assert.equal(frameStep(1000 / 30), 2)
  assert.equal(frameStep(5000), MAX_FRAME_STEP, 'a stall or a returning tab does not teleport the field')
})

test('the first frame has no previous frame to measure against and steps once', () => {
  assert.equal(frameStep(undefined), 1)
  assert.equal(frameStep(NaN), 1)
})

test('the stars run a notch slower than the original, and every star loop uses pace and step', () => {
  assert.ok(STAR_PACE < 1 && STAR_PACE >= 0.7, `a notch, not a crawl: ${STAR_PACE}`)
  const src = readFileSync(new URL('../js/starfield.js', import.meta.url), 'utf8')
  const sets = src.match(/(?<!let )starSpeedScale = [^;]+;/g) || []
  assert.ok(sets.length >= 3, 'the space, day and night star loops each set the speed')
  for (const set of sets) assert.match(set, /\* STAR_PACE \* frameStepScale;$/, set)
})
