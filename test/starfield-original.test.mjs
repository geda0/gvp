// The stars are the ORIGINAL (c7a09b6, 2026-05-19, before the team-tactics kit), restored at
// the owner's request on 2026-10-23 after judging every later star "fix" worse to look at.
//
// This pins it by IDENTITY, not by behaviour: js/starfield.js must contain the original star
// code verbatim - palette, Star (move + show: the radial-gradient glow that grows with
// nearness, the 1.5px gradient streak under 150px), and randomColor. In this repo a "small
// improvement" to the stars has silently replaced the look more than once (2d079aa reverted
// three starfield fixes and the regressions resurfaced months later); any edit to that block
// now fails here, so changing the look has to be a deliberate edit of the fixture too.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calculateFullStarCount } from '../js/starfield-prefs.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const norm = (s) => s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')

test('js/starfield.js contains the original star renderer verbatim', () => {
  const fixture = read('test/fixtures/starfield-original-c7a09b6.txt').split('\n').slice(2).join('\n').trim()
  assert.ok(fixture.includes('function Star()') && fixture.includes('function randomColor()'), 'fixture is the star block')
  assert.ok(norm(read('js/starfield.js')).includes(norm(fixture)), 'the star code differs from the original - restore it, or change the fixture deliberately')
})

test('the original star density: area share x baseStars x cores/4, uncapped', () => {
  assert.equal(calculateFullStarCount(1920, 1080, 4, 717), 717)
  assert.equal(calculateFullStarCount(1920, 1080, 8, 717), 1434)
  assert.equal(calculateFullStarCount(1440, 900, 8, 717), Math.floor((1440 * 900) / (1920 * 1080) * 717 * 2))
})

test('the night path draws the original stars - no depth guards, sprites or comet tails remain', () => {
  const src = read('js/starfield.js')
  for (const gone of ['starDepthFade', 'starIsOffCanvas', 'streakThickness', 'clampStarRadius', 'compensateForClearedTrail', 'starSprites']) {
    assert.ok(!src.includes(gone), `${gone} is a post-original star change and must not come back`)
  }
})

test('every star loop draws then moves, as the original did', () => {
  // The verbatim block pins Star itself; this pins the callers. Moving before showing shifts
  // every star one frame ahead of its streak, which the block check cannot see.
  const src = read('js/starfield.js')
  const moves = src.match(/stars\[\w+\]\.move\(\);/g) || []
  const ordered = src.match(/stars\[(\w+)\]\.show\(\);\s*stars\[\1\]\.move\(\);/g) || []
  assert.ok(moves.length >= 3, `expected the space, day and night star loops, found ${moves.length}`)
  assert.equal(ordered.length, moves.length, 'a star loop calls move() without show() immediately before it')
})
