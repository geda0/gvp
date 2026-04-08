import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STARFIELD_DEFAULT_EXPERIENCE,
  STARFIELD_REDUCED_MOTION,
  STARFIELD_DEFAULT_EASE_TOWARD_REDUCED,
  calculateFullStarCount,
  starCountForPreference,
  snowflakeCountForPreference,
  spaceTrailAlphaForPreference,
  defaultExperienceStarCount,
  defaultExperienceSnowflakeCount,
  starSpeedMultiplierForPreference,
  snowSpeedMultiplierForPreference
} from '../js/starfield-prefs.js'

test('full star count matches reference 1080p @ 4 cores', () => {
  const full = calculateFullStarCount(1920, 1080, 4)
  assert.equal(full, 717)
})

test('reduced-motion star count scales and caps', () => {
  const full = 717
  const reduced = starCountForPreference(full, true)
  assert.equal(reduced, Math.min(Math.floor(717 * 0.34), 280))
  assert.equal(reduced, 243)
})

test('reduced-motion star count respects floor when full count is tiny', () => {
  const full = 10
  const reduced = starCountForPreference(full, true)
  assert.equal(reduced, STARFIELD_REDUCED_MOTION.starMin)
})

test('default star count ignores reduced-motion flag when false', () => {
  assert.equal(starCountForPreference(900, false), 900)
})

test('snow: default 200 flakes; reduced uses mult + min', () => {
  assert.equal(snowflakeCountForPreference(false), STARFIELD_DEFAULT_EXPERIENCE.snowCount)
  assert.equal(
    snowflakeCountForPreference(true),
    Math.max(
      STARFIELD_REDUCED_MOTION.snowMin,
      Math.floor(STARFIELD_DEFAULT_EXPERIENCE.snowCount * STARFIELD_REDUCED_MOTION.snowMult)
    )
  )
  assert.equal(snowflakeCountForPreference(true), 84)
})

test('space trail alpha: default vs reduced', () => {
  assert.equal(spaceTrailAlphaForPreference(false), STARFIELD_DEFAULT_EXPERIENCE.spaceTrailAlpha)
  assert.equal(spaceTrailAlphaForPreference(true), STARFIELD_REDUCED_MOTION.spaceTrailAlpha)
})

test('large full star count hits reduced cap', () => {
  const full = 900
  const reduced = starCountForPreference(full, true)
  assert.equal(reduced, 280)
  assert.equal(reduced, STARFIELD_REDUCED_MOTION.starCap)
})

test('default experience star count eases 15% toward reduced count', () => {
  const full = 717
  const reduced = starCountForPreference(full, true)
  const t = STARFIELD_DEFAULT_EASE_TOWARD_REDUCED.countTowardReduced
  assert.equal(defaultExperienceStarCount(full), Math.round(full + t * (reduced - full)))
  assert.equal(defaultExperienceStarCount(full), 646)
})

test('default experience snow count eases 15% toward reduced snow', () => {
  const full = STARFIELD_DEFAULT_EXPERIENCE.snowCount
  const reduced = snowflakeCountForPreference(true)
  const t = STARFIELD_DEFAULT_EASE_TOWARD_REDUCED.countTowardReduced
  assert.equal(
    defaultExperienceSnowflakeCount(),
    Math.round(full + t * (reduced - full))
  )
  assert.equal(defaultExperienceSnowflakeCount(), 183)
})

test('speed multipliers: default eases 30% toward target; reduced stays 1', () => {
  const b = STARFIELD_DEFAULT_EASE_TOWARD_REDUCED
  assert.equal(
    starSpeedMultiplierForPreference(false),
    1 + b.speedTowardReduced * (b.speedTargetStar - 1)
  )
  assert.equal(
    snowSpeedMultiplierForPreference(false),
    1 + b.speedTowardReduced * (b.speedTargetSnow - 1)
  )
  assert.equal(starSpeedMultiplierForPreference(true), 1)
  assert.equal(snowSpeedMultiplierForPreference(true), 1)
})
