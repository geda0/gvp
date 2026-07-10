import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHOOTER_FRACTION,
  SHOOTER_SPEED_BOOST,
  BG_SPEED_FACTOR,
  STAR_TWINKLE_MIN,
  STAR_MIN_RADIUS,
  TWINKLE_MIN,
  makeShooter,
  starFrameSpeed,
  twinkle,
  starPointRadius
} from '../js/starfield.js'

// The night sky is two populations, not one. MOST stars just sit there as light —
// a dense, gently-twinkling field, drifting calmly. Only a rare, RANDOMLY chosen few
// are "shooters": they move much faster and streak across as meteors. Shooting is
// designated at random (not by who happens to be fast), so it is genuinely occasional
// and random — and the calm majority skip all wake work (cheaper, and quiet).

test('shooters are chosen at RANDOM, and they are rare', () => {
  let shooters = 0
  const N = 20000
  for (let i = 0; i < N; i++) if (makeShooter()) shooters++
  const frac = shooters / N
  assert.ok(Math.abs(frac - SHOOTER_FRACTION) < 0.02, `~${SHOOTER_FRACTION} of stars shoot, saw ${frac.toFixed(3)}`)
  assert.ok(SHOOTER_FRACTION > 0 && SHOOTER_FRACTION < 0.15, 'occasional, not a swarm')
  assert.equal(typeof makeShooter(), 'boolean')
})

test('a shooter moves much faster than the calm background at the same depth', () => {
  for (const depth of [0.1, 0.5, 0.9]) {
    const bg = starFrameSpeed(depth, false)
    const shot = starFrameSpeed(depth, true)
    assert.ok(shot > bg, `at depth ${depth}, a shooter must outrun the drift`)
    assert.ok(Math.abs(shot - bg * SHOOTER_SPEED_BOOST) < 1e-9, 'shooter speed is the background boosted')
  }
})

test('the background drifts calmly — even its closest, fastest star is slow', () => {
  const nearestBg = starFrameSpeed(1, false) // depthRatio 1 = closest
  assert.ok(nearestBg < 2, `background must stay calm, not fast (saw ${nearestBg.toFixed(2)} px/frame)`)
  assert.ok(starFrameSpeed(0.2, false) > starFrameSpeed(0.05, false), 'still perspective: closer drifts a touch faster')
  assert.ok(BG_SPEED_FACTOR > 0)
})

test('speed honours the per-frame speed scale (reduced-motion / dawn easing)', () => {
  assert.equal(starFrameSpeed(0.5, true, 0.08, 0), 0, 'a zero scale freezes the field')
  assert.ok(starFrameSpeed(0.5, true, 0.08, 1) > starFrameSpeed(0.5, true, 0.08, 0.5))
})

// The background light twinkles too, but GENTLY — a soft breathing, not the dramatic
// sparkle of the shooting wake. So the star-point floor is higher (dims less) than
// the wake floor.
test('background starlight twinkles gently — a higher floor than the wake sparkle', () => {
  assert.ok(STAR_TWINKLE_MIN > TWINKLE_MIN, 'a steady light that breathes, not a strobe')
  assert.ok(STAR_TWINKLE_MIN > 0 && STAR_TWINKLE_MIN < 1)
})

// "Way more stars lighting up the sky" only works if the stars are VISIBLE. A far
// background star projects sub-pixel (~0.38px radius) and vanishes — which is why
// the original leaned on the accumulation haze to light them. With the haze gone,
// every star must render at a floor size so the dense field actually lights the sky.
test('a faint background star is floored to a visible size — it lights the sky', () => {
  assert.equal(starPointRadius(0.38), STAR_MIN_RADIUS, 'a sub-pixel star is lifted to the floor')
  assert.equal(starPointRadius(0), STAR_MIN_RADIUS)
  assert.ok(STAR_MIN_RADIUS >= 0.9, 'the floor must be at least ~1px, or the star is invisible')
})

test('a bright close star keeps its real size — the floor only lifts the faint ones', () => {
  assert.equal(starPointRadius(8), 8, 'above the floor, the true radius is used')
  assert.ok(starPointRadius(3) < starPointRadius(6), 'still monotonic above the floor')
})

test('twinkle honours a custom floor so star light and wake sparkle can differ', () => {
  for (let t = 0; t < 12; t += 0.11) {
    const v = twinkle(0.9, 2.0, t, STAR_TWINKLE_MIN)
    assert.ok(v >= STAR_TWINKLE_MIN - 1e-9 && v <= 1 + 1e-9, `star twinkle ${v} out of [${STAR_TWINKLE_MIN}, 1]`)
  }
  // a higher floor is strictly gentler: its dimmest never goes below the wake's dimmest
  let minStar = Infinity
  let minWake = Infinity
  for (let t = 0; t < 10; t += 0.01) {
    minStar = Math.min(minStar, twinkle(0.3, 2.0, t, STAR_TWINKLE_MIN))
    minWake = Math.min(minWake, twinkle(0.3, 2.0, t, TWINKLE_MIN))
  }
  assert.ok(minStar > minWake, 'the background never dims as hard as the wake')
})
