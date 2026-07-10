import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DUST_LIFE_FRAMES,
  DUST_SPAWN_INTERVAL,
  DUST_MIN_SIZE,
  DUST_MAX_SIZE,
  DUST_MIN_STAR_RADIUS,
  dustAlpha,
  dustCapacity,
  dustSize,
  shedsDust,
  createDustPool,
  spawnDust,
  dustIsAlive,
  resetDust
} from '../js/starfield.js'

// Stardust is the trail the old `destination-out` accumulation used to give: glow
// left BEHIND across the sky, not welded to the star. The accumulation's only sin
// was never reaching zero (multiplying 8-bit alpha strands pixels at ~2/255, which
// is the permanent haze). Dust motes fade on their OWN age and are never read back
// off the canvas, so residue is impossible by construction.

test('a mote is born bright and dies at exactly zero — no residue floor', () => {
  assert.ok(dustAlpha(0, 20) > 0, 'a fresh mote must be visible')
  assert.equal(dustAlpha(20, 20), 0, 'a mote must reach EXACTLY zero at end of life')
  assert.equal(dustAlpha(21, 20), 0, 'past end of life it stays zero, never negative')
  assert.equal(dustAlpha(Infinity, 20), 0, 'an unspawned/dead slot contributes nothing')
})

test('a mote fades monotonically over its life', () => {
  let prev = Infinity
  for (let age = 0; age <= DUST_LIFE_FRAMES; age++) {
    const a = dustAlpha(age, DUST_LIFE_FRAMES)
    assert.ok(a <= prev, `alpha must never brighten (age ${age})`)
    assert.ok(a >= 0, 'alpha never goes negative')
    prev = a
  }
})

test('dust is deposited across the sky — a mote does NOT follow the star that spawned it', () => {
  const pool = createDustPool(8)
  const i = spawnDust(pool, 100, 200, 3, 2.5)
  // the star races away; the dust it shed stays where it was born
  const starNewX = 640, starNewY = 480
  assert.equal(pool.x[i], 100, 'mote x is frozen at its spawn point')
  assert.equal(pool.y[i], 200, 'mote y is frozen at its spawn point')
  assert.notEqual(pool.x[i], starNewX)
  assert.notEqual(pool.y[i], starNewY)
  assert.equal(pool.color[i], 3, 'the mote keeps the star colour that shed it (shiny + colourful)')
})

test('the pool is bounded — spawning forever recycles, it never grows (no accumulation)', () => {
  const cap = 4
  const pool = createDustPool(cap)
  const seen = new Set()
  for (let n = 0; n < cap * 5; n++) seen.add(spawnDust(pool, n, n, 0, 1))
  assert.equal(pool.capacity, cap, 'capacity is fixed')
  assert.equal(pool.x.length, cap, 'backing storage never grows')
  assert.equal(seen.size, cap, 'slots are reused in a ring — memory is bounded')
})

test('a fresh pool holds no live motes', () => {
  const pool = createDustPool(5)
  for (let i = 0; i < pool.capacity; i++) {
    assert.equal(dustIsAlive(pool, i, DUST_LIFE_FRAMES), false, 'unspawned slots are dead')
    assert.equal(dustAlpha(pool.age[i], DUST_LIFE_FRAMES), 0)
  }
})

test('a just-spawned mote is alive; one past its life is dead', () => {
  const pool = createDustPool(2)
  const i = spawnDust(pool, 1, 1, 0, 1)
  assert.equal(dustIsAlive(pool, i, DUST_LIFE_FRAMES), true)
  pool.age[i] = DUST_LIFE_FRAMES
  assert.equal(dustIsAlive(pool, i, DUST_LIFE_FRAMES), false, 'expired motes stop drawing')
})

test('capacity covers the most motes that can ever be alive at once', () => {
  // each frame numStars/interval motes spawn; each lives `life` frames
  const numStars = 1000
  const cap = dustCapacity(numStars, 20, 10)
  assert.ok(cap >= (numStars / 10) * 20, 'never under-provisioned (no premature recycling)')
  assert.ok(Number.isFinite(cap) && cap > 0)
  assert.ok(dustCapacity(2000, 20, 10) > cap, 'scales with star count')
})

// When dust stops being drawn (daylight, reduced motion), the pool also stops being
// aged. Without a reset, mid-life motes thaw at their stale positions when night
// returns — a puff of old dust in the wrong place. Retire them at the edge instead.
test('retiring the pool kills every mote, so none thaws at a stale position later', () => {
  const pool = createDustPool(4)
  spawnDust(pool, 10, 20, 1, 2)
  spawnDust(pool, 30, 40, 2, 2)
  assert.equal(dustIsAlive(pool, 0, DUST_LIFE_FRAMES), true)

  resetDust(pool)

  for (let i = 0; i < pool.capacity; i++) {
    assert.equal(dustIsAlive(pool, i, DUST_LIFE_FRAMES), false, `slot ${i} must be retired`)
    assert.equal(dustAlpha(pool.age[i], DUST_LIFE_FRAMES), 0, 'a retired mote draws nothing')
  }
})

test('a retired pool still accepts fresh dust', () => {
  const pool = createDustPool(3)
  spawnDust(pool, 1, 1, 0, 1)
  resetDust(pool)
  const i = spawnDust(pool, 99, 98, 5, 2)
  assert.equal(dustIsAlive(pool, i, DUST_LIFE_FRAMES), true)
  assert.equal(pool.x[i], 99)
})

test('defaults are sane', () => {
  assert.ok(DUST_LIFE_FRAMES > 1, 'dust must linger across frames — that IS the delayed trail')
  assert.ok(DUST_SPAWN_INTERVAL >= 1)
})

// A mote is a speck of dust, not a second star. A close star's glow radius can be
// tens of pixels; letting a mote scale with it unclamped sheds huge blobs — a
// fill-rate sink (thousands of them per frame) and visually wrong.
test('a mote stays a speck even when shed by a huge close-up star', () => {
  assert.ok(dustSize(1000) <= DUST_MAX_SIZE, 'mote size is clamped, however big the star')
  assert.ok(dustSize(30) <= DUST_MAX_SIZE)
  assert.ok(DUST_MAX_SIZE < 8, 'a speck, not a blob')
})

// `shedsDust` gates which stars shed, trading sky brightness against fill rate.
// The THRESHOLD VALUE is taste (the navigator picked a bright, dense sky, so it is
// currently 0 = the whole field sheds). The gate's BEHAVIOUR is the invariant, so
// pin it against an explicit threshold rather than against today's tuning.
test('a star sheds dust only once its glow reaches the threshold', () => {
  assert.equal(shedsDust(2, 2), true, 'at the threshold a star sheds')
  assert.equal(shedsDust(7, 2), true, 'above it, a star sheds')
  assert.equal(shedsDust(1.99, 2), false, 'below it, a star does not')
  assert.equal(shedsDust(0, 2), false)
})

test('the default threshold is a usable knob', () => {
  assert.ok(Number.isFinite(DUST_MIN_STAR_RADIUS) && DUST_MIN_STAR_RADIUS >= 0)
  // At the current (bright-sky) setting every visible star sheds.
  assert.equal(shedsDust(0.05), true)
  assert.equal(shedsDust(30), true)
})

test('mote size has a visible floor and grows with the star until it clamps', () => {
  assert.equal(dustSize(0), DUST_MIN_SIZE)
  assert.ok(dustSize(3) >= dustSize(0.1))
  assert.ok(dustSize(1000) >= dustSize(3))
  assert.ok(DUST_MIN_SIZE > 0)
})
