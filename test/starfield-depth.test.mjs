import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STAR_NEAR_PLANE_RATIO,
  STAR_FADE_START_RATIO,
  STAR_MAX_RADIUS,
  starNearPlane,
  starFadeStart,
  starDepthFade,
  starShouldRecycle,
  clampStarRadius
} from '../js/starfield.js'

// Perspective projection is `size * (focalLength / z)`. With stars recycled only at
// `z <= 0`, a star aimed at the centre of the screen keeps closing on the camera and
// its radius runs away — at z = 0.01*W it projects to ~313px. That is the beach-ball
// that flies into the viewer's face. Three guards, in order of bluntness:
//   1. a NEAR PLANE recycles a star before it can reach the camera at all
//   2. a DEPTH FADE dissolves it on the way in, so it never pops out of existence
//   3. a hard RADIUS CLAMP, so no arithmetic can ever produce a ball

const W = 1000

test('a star is recycled at the near plane — it never reaches the camera', () => {
  assert.equal(starShouldRecycle(starNearPlane(W), 10, 10, W, 800), true, 'at the near plane it recycles')
  assert.equal(starShouldRecycle(starNearPlane(W) - 1, 10, 10, W, 800), true, 'past it, certainly')
  assert.equal(starShouldRecycle(starNearPlane(W) + 1, 10, 10, W, 800), false, 'just in front of it, it lives')
  assert.ok(starNearPlane(W) > 0, 'the near plane must actually stop the star short of z=0')
})

test('a star that leaves the frame is still recycled', () => {
  const live = starFadeStart(W) + 10
  assert.equal(starShouldRecycle(live, -1, 10, W, 800), true)
  assert.equal(starShouldRecycle(live, W + 1, 10, W, 800), true)
  assert.equal(starShouldRecycle(live, 10, -1, W, 800), true)
  assert.equal(starShouldRecycle(live, 10, 801, W, 800), true)
  assert.equal(starShouldRecycle(live, 10, 10, W, 800), false)
})

test('a star fades out as it approaches, instead of popping', () => {
  assert.equal(starDepthFade(W, W), 1, 'far away it is fully visible')
  assert.equal(starDepthFade(starFadeStart(W), W), 1, 'still full at the fade start')
  assert.equal(starDepthFade(starNearPlane(W), W), 0, 'fully gone by the near plane — no pop')
  assert.equal(starDepthFade(starNearPlane(W) - 100, W), 0, 'never negative past it')

  const mid = (starFadeStart(W) + starNearPlane(W)) / 2
  const m = starDepthFade(mid, W)
  assert.ok(m > 0 && m < 1, 'partially faded in between')
})

test('the depth fade is monotonic in z and stays within [0,1]', () => {
  let prev = -1
  for (let z = 0; z <= W; z += W / 50) {
    const f = starDepthFade(z, W)
    assert.ok(f >= 0 && f <= 1, `fade out of range at z=${z}: ${f}`)
    assert.ok(f >= prev, 'fade must never dim as the star moves further away')
    prev = f
  }
})

test('no star can ever render as a ball, whatever the arithmetic says', () => {
  assert.equal(clampStarRadius(313), STAR_MAX_RADIUS, 'the runaway z->0 radius is clamped')
  assert.equal(clampStarRadius(1e9), STAR_MAX_RADIUS)
  assert.ok(STAR_MAX_RADIUS < 12, 'a star is a point of light, not a beach ball')
})

test('the clamp leaves normal, distant stars untouched', () => {
  assert.equal(clampStarRadius(0.8), 0.8)
  assert.equal(clampStarRadius(5.4), 5.4)
  assert.ok(clampStarRadius(3) < clampStarRadius(6), 'below the cap, bigger is still bigger')
})

test('the fade band sits in front of the near plane', () => {
  assert.ok(STAR_FADE_START_RATIO > STAR_NEAR_PLANE_RATIO, 'stars must begin fading before they are recycled')
  assert.ok(STAR_NEAR_PLANE_RATIO > 0 && STAR_FADE_START_RATIO < 1)
  assert.ok(starFadeStart(W) > starNearPlane(W))
})
