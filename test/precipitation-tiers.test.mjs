import test from 'node:test'
import assert from 'node:assert/strict'

import { PRECIPITATION_KINDS, FALLBACK_KIND } from '../js/precipitation.js'
import {
  STARFIELD_DEFAULT_EXPERIENCE,
  STARFIELD_REDUCED_MOTION,
  snowflakeCountForPreference,
  snowSpeedMultiplierForPreference,
  defaultExperienceSnowflakeCount,
  precipitationCountForPreference,
  precipitationSpeedMultiplierForPreference,
  defaultExperiencePrecipitationCount
} from '../js/starfield-prefs.js'

// How much falls, per kind and per motion preference (ADR-0016 §5).
//
// `js/precipitation.js` answers WHAT falls; this file is WHAT COUNTS. Two questions, two
// owners — a descriptor that carried counts would make the decision leaf a second source of
// truth for numbers invariant #6 already points at `js/starfield-prefs.js` for.
//
// THE TESTS ARE RELATIONAL, not golden, except where a golden number is already pinned
// elsewhere. `rainCount` and `hailCount` are explicitly tunable starting points, so
// asserting them by value would mean a visual tweak has to edit a test — which teaches
// people to edit tests. What does NOT move under tuning is the shape: every kind has a row,
// reduced is less than default, the floor is above zero, and nothing is NaN.

const BOTH = [false, true]

test('every kind in the registry has a tier — iterated, not named', () => {
  // Iterating PRECIPITATION_KINDS rather than writing three kinds is the point: adding a
  // fourth kind without a tier then fails a test instead of rendering nothing.
  for (const kind of PRECIPITATION_KINDS) {
    for (const rm of BOTH) {
      const count = precipitationCountForPreference(kind, rm)
      assert.ok(
        Number.isInteger(count) && count > 0,
        `${kind} (reduced=${rm}) must have a positive integer count, got ${count}`
      )
      const speed = precipitationSpeedMultiplierForPreference(kind, rm)
      assert.ok(
        Number.isFinite(speed) && speed > 0 && speed <= 1,
        `${kind} (reduced=${rm}) speed multiplier must be in (0, 1], got ${speed}`
      )
    }
    assert.ok(
      Number.isInteger(defaultExperiencePrecipitationCount(kind))
      && defaultExperiencePrecipitationCount(kind) > 0,
      `${kind} must have a default-experience count`
    )
  }
})

test('snow delegates, so its numbers are byte-identical and the old helper stays CALLED', () => {
  // Wrap, not replace. `snowflakeCountForPreference` is named in invariant #6's
  // implemented-by list and asserted by name with the literal 84 in
  // test/starfield-reduced-motion.test.mjs; deleting it means editing an invariant and a
  // green test to buy nothing. And this repo's scar tissue is a defined-but-never-called
  // helper, so keeping it on the live path matters more than tidiness.
  for (const rm of BOTH) {
    assert.equal(
      precipitationCountForPreference('snow', rm), snowflakeCountForPreference(rm),
      `snow must delegate exactly (reduced=${rm})`
    )
    assert.equal(
      precipitationSpeedMultiplierForPreference('snow', rm),
      snowSpeedMultiplierForPreference(rm),
      'including snowSpeedMultiplierForPreference\'s current `return 1` under reduced ' +
      'motion — snow is gentle enough that cutting its count is the whole tier, and ' +
      'changing that here would alter the shipped look under the guise of adding rain'
    )
  }
  assert.equal(
    defaultExperiencePrecipitationCount('snow'), defaultExperienceSnowflakeCount()
  )
})

test('reduced motion means LESS of it, for every kind', () => {
  for (const kind of PRECIPITATION_KINDS) {
    assert.ok(
      precipitationCountForPreference(kind, true) < precipitationCountForPreference(kind, false),
      `${kind}: the reduced count must be lower than the default one`
    )
  }
})

test('reduced motion means SLOWER too, for the kinds that actually move fast', () => {
  // The clause ADR-0016 §8 adds to invariant #6, and §5.3's measured reason for it: the
  // shipped reduced tier cuts COUNT and not speed. For snow at 0.6-1.8 px/frame that is
  // defensible. For rain at roughly an order of magnitude more displacement per frame, the
  // thing a reduced-motion visitor is reacting to IS the speed — so a rain tier that cut
  // only the count would ship fast streaks to the people who asked for less motion while
  // staying fully compliant with #6's current wording, and green.
  for (const kind of ['rain', 'hail']) {
    assert.ok(
      precipitationSpeedMultiplierForPreference(kind, true)
        < precipitationSpeedMultiplierForPreference(kind, false),
      `${kind}: reduced motion must slow it down, not merely thin it out`
    )
  }
})

test('the reduced floor is above zero — softened, not deleted', () => {
  // A reduced-motion visitor who sees NO precipitation has not had the feature softened,
  // they have had it removed.
  for (const kind of PRECIPITATION_KINDS) {
    assert.ok(
      precipitationCountForPreference(kind, true) >= 8,
      `${kind}: a reduced count of ${precipitationCountForPreference(kind, true)} is a ` +
      'deletion dressed as a preference'
    )
  }
})

test('an unknown kind resolves to the fallback row rather than returning undefined', () => {
  for (const bad of ['sleet', '', null, undefined, 42, {}]) {
    for (const rm of BOTH) {
      assert.equal(
        precipitationCountForPreference(bad, rm),
        precipitationCountForPreference(FALLBACK_KIND, rm),
        `${JSON.stringify(bad) ?? String(bad)} must resolve through parsePrecipitationKind`
      )
      assert.equal(
        precipitationSpeedMultiplierForPreference(bad, rm),
        precipitationSpeedMultiplierForPreference(FALLBACK_KIND, rm)
      )
    }
    assert.equal(
      defaultExperiencePrecipitationCount(bad),
      defaultExperiencePrecipitationCount(FALLBACK_KIND)
    )
  }
})

test('the constants block stays the single source of truth', () => {
  // Invariant #6 points at js/starfield-prefs.js's constants. A kind whose numbers lived in
  // the renderer would be a second source, and the renderer is the one place that must not
  // decide anything (ADR-0016 §3).
  for (const key of ['snowCount', 'rainCount', 'hailCount']) {
    assert.ok(
      Number.isInteger(STARFIELD_DEFAULT_EXPERIENCE[key]) && STARFIELD_DEFAULT_EXPERIENCE[key] > 0,
      `STARFIELD_DEFAULT_EXPERIENCE.${key} is missing`
    )
  }
  for (const key of ['rainMult', 'rainMin', 'rainSpeedMult', 'hailMult', 'hailMin', 'hailSpeedMult']) {
    assert.ok(
      Number.isFinite(STARFIELD_REDUCED_MOTION[key]),
      `STARFIELD_REDUCED_MOTION.${key} is missing`
    )
  }
  assert.equal(
    STARFIELD_DEFAULT_EXPERIENCE.snowCount, 200,
    'the shipped snow count must not move while rain is being added'
  )
})

test('no count scales with the viewport or the core count', () => {
  // test/starfield-star-budget.test.mjs clamps the STAR count because it scales with area
  // and cores. Precipitation counts are deliberately fixed — 183 flakes at a fixed count is
  // the shipped design — so these take no arguments beyond kind and preference. If one ever
  // gains an area term it needs that test's clamp, and this row is where that is noticed.
  assert.equal(
    precipitationCountForPreference.length, 2,
    'precipitationCountForPreference takes (kind, prefersReducedMotion) and nothing else'
  )
  assert.equal(defaultExperiencePrecipitationCount.length, 1)
})
