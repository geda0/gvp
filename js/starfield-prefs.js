/**
 * Starfield defaults vs prefers-reduced-motion tuning (single source of truth).
 * Imported by starfield.js and tests.
 */

export const STARFIELD_DEFAULT_EXPERIENCE = {
  snowCount: 200,
  spaceTrailAlpha: 0.59,
  baseStars: 717
}

export const STARFIELD_REDUCED_MOTION = {
  starMult: 0.34,
  starCap: 280,
  starMin: 36,
  snowMult: 0.42,
  snowMin: 28,
  spaceTrailAlpha: 0.66
}

/**
 * Default experience only: nudge counts/speed toward the reduced tier.
 * Reduced-motion rendering still uses starCountForPreference(..., true) etc. unchanged.
 */
export const STARFIELD_DEFAULT_EASE_TOWARD_REDUCED = {
  countTowardReduced: 0.15,
  speedTowardReduced: 0.3,
  /** Interpolation targets for speed only (reduced path does not apply these). */
  speedTargetStar: 0.72,
  speedTargetSnow: 0.78
}

export function calculateFullStarCount(width, height, coresCount, baseStars) {
  const area = width * height
  const scaleFactor = coresCount / 4
  const stars = baseStars ?? STARFIELD_DEFAULT_EXPERIENCE.baseStars
  return Math.floor((area / (1920 * 1080)) * stars * scaleFactor)
}

export function starCountForPreference(fullCount, prefersReducedMotion) {
  if (!prefersReducedMotion) return fullCount
  const rm = STARFIELD_REDUCED_MOTION
  let n = Math.floor(fullCount * rm.starMult)
  n = Math.min(n, rm.starCap)
  return Math.max(rm.starMin, n)
}

export function snowflakeCountForPreference(prefersReducedMotion) {
  const def = STARFIELD_DEFAULT_EXPERIENCE
  const rm = STARFIELD_REDUCED_MOTION
  if (!prefersReducedMotion) return def.snowCount
  return Math.max(rm.snowMin, Math.floor(def.snowCount * rm.snowMult))
}

export function spaceTrailAlphaForPreference(prefersReducedMotion) {
  const def = STARFIELD_DEFAULT_EXPERIENCE
  const rm = STARFIELD_REDUCED_MOTION
  return prefersReducedMotion ? rm.spaceTrailAlpha : def.spaceTrailAlpha
}

export function defaultExperienceStarCount(fullCount) {
  const toward = starCountForPreference(fullCount, true)
  const t = STARFIELD_DEFAULT_EASE_TOWARD_REDUCED.countTowardReduced
  return Math.max(1, Math.round(fullCount + t * (toward - fullCount)))
}

export function defaultExperienceSnowflakeCount() {
  const full = STARFIELD_DEFAULT_EXPERIENCE.snowCount
  const toward = snowflakeCountForPreference(true)
  const t = STARFIELD_DEFAULT_EASE_TOWARD_REDUCED.countTowardReduced
  return Math.max(1, Math.round(full + t * (toward - full)))
}

export function starSpeedMultiplierForPreference(prefersReducedMotion) {
  if (prefersReducedMotion) return 1
  const b = STARFIELD_DEFAULT_EASE_TOWARD_REDUCED
  return 1 + b.speedTowardReduced * (b.speedTargetStar - 1)
}

export function snowSpeedMultiplierForPreference(prefersReducedMotion) {
  if (prefersReducedMotion) return 1
  const b = STARFIELD_DEFAULT_EASE_TOWARD_REDUCED
  return 1 + b.speedTowardReduced * (b.speedTargetSnow - 1)
}
