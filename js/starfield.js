// starfield.js - Theme-aware canvas (starfield | snow)
import {
  STARFIELD_DEFAULT_EXPERIENCE,
  calculateFullStarCount,
  starCountForPreference,
  snowflakeCountForPreference,
  fireflyCountForPreference,
  spaceTrailAlphaForPreference,
  defaultExperienceStarCount,
  defaultExperienceSnowflakeCount,
  starSpeedMultiplierForPreference,
  snowSpeedMultiplierForPreference
} from './starfield-prefs.js'
import { sceneParamsAt } from './theme-time.js'

/**
 * Comet-tail geometry (module scope so it is testable without a canvas).
 *
 * The night sky used to build its tails by NOT clearing: a `destination-out`
 * erase at alpha 0.22 kept 78% of the previous frame, so each star's glow piled
 * up over ~14 frames. That accumulation is also why trails never went away —
 * multiplying 8-bit alpha by 0.78 leaves pixels stuck at alpha 1 forever.
 *
 * Instead we clear fully every frame and draw the ENTIRE tail each frame, from a
 * point STREAK_TAIL_FRAMES worth of motion behind the star. Same comet, drawn
 * fresh: no accumulation, no residue, still one drawImage per star.
 */
// The streak is the ORIGINAL motion line: roughly one frame of travel, thin. The
// sky's brightness and its lingering trail come from stardust (below), never from
// a fat streak — a hairline under a big glow reads as a LOLLIPOP, and a streak
// scaled to the glow's diameter reads as a MANTIS RAY. Thin and bounded, always.
export const STREAK_TAIL_FRAMES = 1;
/** Longest tail we draw — a fast or respawned star must not smear across the screen. */
export const STREAK_MAX_DIST = 150;
/** Sub-pixel tails are invisible; skip the draw entirely. */
export const STREAK_MIN_DIST = 1;

/** Streak width grows gently with the glow, then clamps — never a wing. */
export const STREAK_HEAD_RATIO = 0.16;
export const STREAK_MIN_THICKNESS = 1.2;
export const STREAK_MAX_THICKNESS = 3;

/**
 * Stardust — the trail the old uncleared canvas used to give, done so it actually
 * ends. Each star sheds a mote every DUST_SPAWN_INTERVAL frames. A mote is FROZEN
 * where it was born (it does not follow the star), keeps that star's colour, and
 * fades on its own age to EXACTLY zero at DUST_LIFE_FRAMES. Alpha is computed from
 * age and never read back off the canvas, so the 8-bit rounding that stranded the
 * old `destination-out` fade at ~2/255 (the permanent haze) cannot happen here.
 */
export const DUST_LIFE_FRAMES = 22;
/** Shed often enough that the trail reads as a lit path, not a dotted line. */
export const DUST_SPAWN_INTERVAL = 4;
export const DUST_PEAK_ALPHA = 0.75;
/**
 * A mote is a soft speck, not a second star. The clamp matters twice over: a close
 * star's glow radius is tens of pixels, so an unclamped mote is both a fat blob and
 * — multiplied by thousands of motes a frame — a fill-rate sink.
 */
export const DUST_SIZE_RATIO = 0.8;
export const DUST_MIN_SIZE = 0.9;
export const DUST_MAX_SIZE = 3.2;
/**
 * Brightness/cost knob: the smallest star glow that sheds dust. Raise it and only
 * close, visibly-streaking stars shed (cheaper, dimmer sky); at 0 the whole field
 * sheds, which is the denser, brighter sky the navigator signed off on. Taste, not
 * an invariant — `shedsDust` is pinned against an explicit threshold instead.
 */
export const DUST_MIN_STAR_RADIUS = 0;
/** Below this the mote adds nothing a viewer can see — skip the draw, keep the frame cheap. */
export const DUST_CULL_ALPHA = 0.02;

export const STAR_GLOW_SCALE = 2.1;
export const STREAK_ALPHA = 0.42;

/**
 * Depth guards. The projection is `size * (focalLength / z)`, so a star aimed near
 * the centre of the screen grows without bound as z approaches the camera — at
 * z = 0.01*W it projects to ~313px, a beach ball flying into the viewer's face.
 * Three guards, bluntest last:
 *   1. NEAR PLANE  — recycle the star before it can ever reach the camera.
 *   2. DEPTH FADE  — dissolve it on the way in, so it never pops out of existence.
 *   3. RADIUS CLAMP — a hard ceiling, so no arithmetic can produce a ball.
 * Ratios are of the canvas width (z is seeded in [0, width) and focalLength = width).
 */
export const STAR_NEAR_PLANE_RATIO = 0.15;
export const STAR_FADE_START_RATIO = 0.32;
export const STAR_MAX_RADIUS = 9;

export function starNearPlane(width) {
  return width * STAR_NEAR_PLANE_RATIO;
}

export function starFadeStart(width) {
  return width * STAR_FADE_START_RATIO;
}

/** 1 while far away, easing to 0 at the near plane. Never pops. */
export function starDepthFade(z, width) {
  const near = starNearPlane(width);
  if (z <= near) return 0;
  const start = starFadeStart(width);
  if (z >= start) return 1;
  return (z - near) / (start - near);
}

/** A star is retired at the near plane, or once it has drifted out of frame. */
export function starShouldRecycle(z, x, y, width, height) {
  return z <= starNearPlane(width) || x < 0 || x > width || y < 0 || y > height;
}

/** A star is a point of light, never a ball — whatever the projection returns. */
export function clampStarRadius(radius) {
  return Math.min(radius, STAR_MAX_RADIUS);
}

/** Tail length for a star that moved `frameDelta` px this frame. */
export function streakLength(frameDelta, tailFrames = STREAK_TAIL_FRAMES) {
  return Math.min(frameDelta * tailFrames, STREAK_MAX_DIST);
}

/** Streak thickness for a star whose glow radius is `starRadius` — thin, clamped. */
export function streakThickness(starRadius) {
  const t = starRadius * STREAK_HEAD_RATIO;
  if (t < STREAK_MIN_THICKNESS) return STREAK_MIN_THICKNESS;
  return Math.min(t, STREAK_MAX_THICKNESS);
}

/** A mote's opacity from its own age. Hits exactly 0 at end of life — no residue. */
export function dustAlpha(age, life = DUST_LIFE_FRAMES) {
  if (!(age < life)) return 0; // also catches Infinity (an unspawned slot)
  if (age <= 0) return 1;
  const t = 1 - age / life;
  return t * t; // ease-out: bright when shed, gone when spent
}

/** Does a star of this glow radius shed dust at all? */
export function shedsDust(starRadius, threshold = DUST_MIN_STAR_RADIUS) {
  return starRadius >= threshold;
}

/** Speck radius for a mote shed by a star of glow radius `starRadius`. */
export function dustSize(starRadius) {
  const s = starRadius * DUST_SIZE_RATIO;
  if (s < DUST_MIN_SIZE) return DUST_MIN_SIZE;
  return Math.min(s, DUST_MAX_SIZE);
}

/** Most motes that can be alive at once: spawns-per-frame x lifetime. */
export function dustCapacity(numStars, life = DUST_LIFE_FRAMES, interval = DUST_SPAWN_INTERVAL) {
  return Math.ceil(numStars / interval) * life;
}

/** Fixed-size ring. Spawning past the end recycles the oldest slot — never grows. */
export function createDustPool(capacity) {
  return {
    capacity,
    head: 0,
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    size: new Float64Array(capacity),
    color: new Int32Array(capacity),
    age: new Float64Array(capacity).fill(Infinity) // Infinity == dead slot
  };
}

export function spawnDust(pool, x, y, colorIndex, size) {
  const i = pool.head;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.color[i] = colorIndex;
  pool.size[i] = size;
  pool.age[i] = 0;
  pool.head = (i + 1) % pool.capacity;
  return i;
}

export function dustIsAlive(pool, i, life = DUST_LIFE_FRAMES) {
  return pool.age[i] < life;
}

/**
 * Retire every mote. Called when dust stops being drawn (daylight, reduced motion):
 * the pool also stops being AGED then, so without this, mid-life motes would thaw at
 * their stale positions when night returns — a puff of old dust in the wrong place.
 */
export function resetDust(pool) {
  pool.age.fill(Infinity);
}

/**
 * Compensation repays exactly ONE debt: the glow the old default-motion night path
 * accumulated on an uncleared canvas. Paths that already cleared every frame owe
 * nothing and must render exactly as before.
 *   - reduced-motion night erased at alpha 1 — a FULL clear, it never accumulated
 *   - the daytime path already called clearRect — it never accumulated
 * Brightening either would be an unasked visual (and a11y) regression.
 */
export function compensateForClearedTrail(prefersReducedMotion, dayScene) {
  return !prefersReducedMotion && !dayScene;
}

/** Living time-of-day mode is active when theme.js has marked the root. */
function isTimeMode() {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-time')
}

/** Current hour the theme is rendering (set on the root by theme.js). */
function currentTimeHours() {
  const v = parseFloat(document.documentElement.dataset.timeHours)
  return Number.isFinite(v) ? v : 12
}

export function initStarfield(canvasId, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const c = canvas.getContext('2d');
  const getTheme = options.getTheme || (() => 'space');

  const config = {
    baseSpeed: 0.1,
    baseStars: STARFIELD_DEFAULT_EXPERIENCE.baseStars
  }

  let stars = [];
  let numStars = 0;
  let centerX, centerY, fl;
  const cores = window.navigator.hardwareConcurrency || 4;

  // Snow state (garden theme)
  let snowflakes = [];
  const snowSpeedMin = 0.6;
  const snowSpeedMax = 1.8;
  const snowRadiusMin = 1;
  const snowRadiusMax = 3;
  const snowDriftAmplitude = 0.3;

  // Snowflake sprite — render the radial gradient once at max radius, then
  // drawImage it per flake. Previously we built a fresh createRadialGradient
  // per flake per frame (~6k allocations/sec at 100 flakes × 60fps).
  const SNOW_SPRITE_RADIUS = snowRadiusMax;
  const SNOW_SPRITE_SIZE = SNOW_SPRITE_RADIUS * 2;
  const snowSprite = document.createElement('canvas');
  snowSprite.width = SNOW_SPRITE_SIZE;
  snowSprite.height = SNOW_SPRITE_SIZE;
  {
    const sc = snowSprite.getContext('2d');
    const cx = SNOW_SPRITE_RADIUS;
    const cy = SNOW_SPRITE_RADIUS;
    const g = sc.createRadialGradient(cx, cy, 0, cx, cy, SNOW_SPRITE_RADIUS);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
    g.addColorStop(0.6, 'rgba(255, 255, 255, 0.5)');
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    sc.fillStyle = g;
    sc.beginPath();
    sc.arc(cx, cy, SNOW_SPRITE_RADIUS, 0, Math.PI * 2);
    sc.fill();
  }

  // Firefly state (living theme, dusk/evening). Warm golden motes drifting low.
  let fireflies = [];
  const FIREFLY_SPRITE_RADIUS = 6;
  const fireflySprite = document.createElement('canvas');
  fireflySprite.width = FIREFLY_SPRITE_RADIUS * 2;
  fireflySprite.height = FIREFLY_SPRITE_RADIUS * 2;
  {
    const fc = fireflySprite.getContext('2d');
    const g = fc.createRadialGradient(
      FIREFLY_SPRITE_RADIUS, FIREFLY_SPRITE_RADIUS, 0,
      FIREFLY_SPRITE_RADIUS, FIREFLY_SPRITE_RADIUS, FIREFLY_SPRITE_RADIUS
    );
    g.addColorStop(0, 'rgba(255, 244, 170, 0.95)');
    g.addColorStop(0.4, 'rgba(255, 212, 94, 0.55)');
    g.addColorStop(1, 'rgba(255, 212, 94, 0)');
    fc.fillStyle = g;
    fc.beginPath();
    fc.arc(FIREFLY_SPRITE_RADIUS, FIREFLY_SPRITE_RADIUS, FIREFLY_SPRITE_RADIUS, 0, Math.PI * 2);
    fc.fill();
  }

  const reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
  let prefersReducedMotion = reducedMotionMql.matches;
  reducedMotionMql.addEventListener('change', () => {
    prefersReducedMotion = reducedMotionMql.matches;
    resizeCanvas();
  });

  /** Set in drawSpace each frame; Star.move multiplies depth speed by this. */
  let starSpeedScale = 1;

  /**
   * Set per frame by the draw path, exactly like starSpeedScale. Only the
   * default-motion night path lost accumulated glow, so only it is compensated;
   * every already-clearing path keeps its original single-pass look.
   */
  let starGlowScale = 1;
  let starTailFrames = 1;

  /** Stardust: a bounded ring of motes shed by the stars. Sized in resizeCanvas. */
  let dustPool = null;
  let dustEnabled = false;
  let frameCount = 0;

  /** Called by each draw path before the star loop. */
  function setTrailCompensation(compensate) {
    starGlowScale = compensate ? STAR_GLOW_SCALE : 1;
    starTailFrames = compensate ? STREAK_TAIL_FRAMES : 1;
  }

  /**
   * Single place every draw path toggles dust. On the true->false edge the pool is
   * retired, because a pool that is not drawn is also not aged — leaving it live
   * would thaw stale motes at old positions when dust switches back on.
   */
  function setDustEnabled(enabled) {
    if (dustEnabled && !enabled && dustPool) resetDust(dustPool);
    dustEnabled = enabled;
  }

  /**
   * Draw + age the stardust the stars have shed. Motes sit where they were born,
   * fade on their own age, and stop drawing at exactly zero — the canvas is cleared
   * every frame, so nothing can accumulate.
   */
  function drawDust(weight) {
    if (!dustPool) return;
    c.save();
    for (let i = 0; i < dustPool.capacity; i++) {
      const age = dustPool.age[i];
      if (!(age < DUST_LIFE_FRAMES)) continue; // dead / never spawned
      const a = dustAlpha(age, DUST_LIFE_FRAMES) * DUST_PEAK_ALPHA * weight;
      if (a > DUST_CULL_ALPHA) {
        const sz = dustPool.size[i];
        c.globalAlpha = a;
        c.drawImage(
          dustSprites[dustPool.color[i]],
          dustPool.x[i] - sz, dustPool.y[i] - sz, sz * 2, sz * 2
        );
      }
      dustPool.age[i] = age + 1;
    }
    c.restore();
  }

  // Precomputed color palette: stars pick from this instead of building an
  // hsl() string on every spawn/respawn. Visually equivalent to randomColor().
  const STAR_PALETTE_SIZE = 64;
  const starPalette = [];
  for (let i = 0; i < STAR_PALETTE_SIZE; i++) {
    starPalette.push(randomColor());
  }

  function paletteColorIndex() {
    return (Math.random() * STAR_PALETTE_SIZE) | 0;
  }

  // Star sprites — same trick as the snowflake sprite above, but the stars are
  // ~1100 per frame (vs ~200 flakes), so this is where it actually pays: we were
  // building a fresh radial gradient PER STAR PER FRAME (~68k allocations/sec) and
  // a fresh linear gradient per motion streak (~64k/sec). Bake one glow sprite and
  // one streak strip per palette colour once, then drawImage them.
  const STAR_SPRITE_RADIUS = 32;
  const STREAK_SPRITE_W = 64;
  // Tall enough to render the teardrop taper smoothly; scaled down per-draw.
  const STREAK_SPRITE_H = 32;

  // A mote is only a couple of pixels on screen. Downscaling the 64px star glow
  // for each of ~5k motes a frame is pure waste — bake a small speck instead.
  const DUST_SPRITE_RADIUS = 6;

  const starSprites = [];
  const streakSprites = [];
  const dustSprites = [];
  for (let i = 0; i < STAR_PALETTE_SIZE; i++) {
    const color = starPalette[i];

    const dustSprite = document.createElement('canvas');
    dustSprite.width = DUST_SPRITE_RADIUS * 2;
    dustSprite.height = DUST_SPRITE_RADIUS * 2;
    const dc = dustSprite.getContext('2d');
    const dg = dc.createRadialGradient(
      DUST_SPRITE_RADIUS, DUST_SPRITE_RADIUS, 0,
      DUST_SPRITE_RADIUS, DUST_SPRITE_RADIUS, DUST_SPRITE_RADIUS
    );
    dg.addColorStop(0, color);
    dg.addColorStop(0.35, color);
    dg.addColorStop(1, 'transparent');
    dc.fillStyle = dg;
    dc.beginPath();
    dc.arc(DUST_SPRITE_RADIUS, DUST_SPRITE_RADIUS, DUST_SPRITE_RADIUS, 0, Math.PI * 2);
    dc.fill();
    dustSprites.push(dustSprite);

    // Radial glow, colour at the core fading to transparent (identical stops to
    // the per-frame gradient it replaces).
    const glowSprite = document.createElement('canvas');
    glowSprite.width = STAR_SPRITE_RADIUS * 2;
    glowSprite.height = STAR_SPRITE_RADIUS * 2;
    const gc = glowSprite.getContext('2d');
    const rg = gc.createRadialGradient(
      STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, 0,
      STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS
    );
    // Solid core out to 22% of the radius so a sub-pixel star still reads as a
    // point of light in a single pass, then a soft falloff for the halo.
    rg.addColorStop(0, color);
    rg.addColorStop(0.22, color);
    rg.addColorStop(1, 'transparent');
    gc.fillStyle = rg;
    gc.beginPath();
    gc.arc(STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, 0, Math.PI * 2);
    gc.fill();
    starSprites.push(glowSprite);

    // Comet sprite: a teardrop that tapers from a point at the tail (x=0) to full
    // width at the head (x=W), with the colour fading transparent→STREAK_ALPHA
    // along its length. Drawn rotated/scaled so the head lands on the star and the
    // round glow drawn on top hides the join — a comet, not a stick with a ball.
    const streakSprite = document.createElement('canvas');
    streakSprite.width = STREAK_SPRITE_W;
    streakSprite.height = STREAK_SPRITE_H;
    const sc2 = streakSprite.getContext('2d');
    const lg = sc2.createLinearGradient(0, 0, STREAK_SPRITE_W, 0);
    lg.addColorStop(0, 'transparent');
    lg.addColorStop(1, color.replace('hsl(', 'hsla(').replace(')', `, ${STREAK_ALPHA})`));
    sc2.fillStyle = lg;
    const midY = STREAK_SPRITE_H / 2;
    sc2.beginPath();
    sc2.moveTo(0, midY);                                   // tail point
    sc2.lineTo(STREAK_SPRITE_W * 0.55, 0);                 // widen toward the head
    sc2.quadraticCurveTo(STREAK_SPRITE_W, 0, STREAK_SPRITE_W, midY);  // rounded head top
    sc2.quadraticCurveTo(STREAK_SPRITE_W, STREAK_SPRITE_H, STREAK_SPRITE_W * 0.55, STREAK_SPRITE_H);
    sc2.closePath();
    sc2.fill();
    streakSprites.push(streakSprite);
  }

  function Star(index) {
    // Staggers dust shedding across frames so motes appear steadily, not in bursts.
    this.idx = index | 0;
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    // Seed in front of the near plane, so a fresh star is never recycled on frame 1.
    const near = starNearPlane(canvas.width);
    this.z = near + Math.random() * (canvas.width - near);
    this.colorIndex = paletteColorIndex();
    this.size = Math.random() / 2;
    this.px = null;
    this.py = null;

    this.move = function () {
      var speed =
        (config.baseSpeed + (canvas.width - this.z) / canvas.width * 4) *
        starSpeedScale;
      this.z = this.z - speed;

      if (starShouldRecycle(this.z, this.x, this.y, canvas.width, canvas.height)) {
        this.z = canvas.width;
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.colorIndex = paletteColorIndex();
        this.px = null;
        this.py = null;
      }
    };

    this.show = function () {
      var x, y, s;
      x = (this.x - centerX) * (fl / this.z);
      x = x + centerX;

      y = (this.y - centerY) * (fl / this.z);
      y = y + centerY;

      s = this.size * (fl / this.z);

      this.glow = (canvas.width - this.z) / canvas.width * 15;

      // Dissolve the star as it closes on the camera, so it leaves the scene by the
      // near plane instead of popping — and never as a ball, thanks to the clamp.
      const fade = starDepthFade(this.z, canvas.width);
      if (fade <= 0) return;

      // Glow radius drives the star sprite, the streak width, and the mote size.
      const radius = clampStarRadius(s * (1.5 + this.glow / 10) * starGlowScale);

      // Everything this star draws this frame is scaled by its depth fade.
      const layerAlpha = c.globalAlpha;
      c.globalAlpha = layerAlpha * fade;

      // Shed a mote of stardust where the star is right now. It stays here and
      // fades out on its own — it does not travel with the star.
      if (dustEnabled && shedsDust(radius) && (frameCount + this.idx) % DUST_SPAWN_INTERVAL === 0) {
        spawnDust(dustPool, x, y, this.colorIndex, dustSize(radius));
      }

      // Motion streaks: default only (reduced-motion users get stars without streaks).
      // The baked teardrop sprite carries the tail→head fade, so no gradient per frame.
      if (
        !prefersReducedMotion &&
        this.px !== null &&
        this.py !== null
      ) {
        const dx = x - this.px;
        const dy = y - this.py;
        const dist = Math.hypot(dx, dy);
        const tail = streakLength(dist, starTailFrames);
        if (tail >= STREAK_MIN_DIST) {
          // Draw the whole comet each frame, tail-end `tail` px behind the star,
          // so the sprite's transparent→colour fade lands head-on at (x, y). The
          // head is as wide as the glow, tapering to a point at the tail.
          const thick = streakThickness(radius);
          c.save();
          c.translate(x - (dx / dist) * tail, y - (dy / dist) * tail);
          c.rotate(Math.atan2(dy, dx));
          c.drawImage(
            streakSprites[this.colorIndex],
            0, -thick / 2, tail, thick
          );
          c.restore();
        }
      }

      // Draw the star: scale the baked glow sprite to this star's radius.
      if (radius > 0) {
        c.drawImage(
          starSprites[this.colorIndex],
          x - radius, y - radius, radius * 2, radius * 2
        );
      }

      c.globalAlpha = layerAlpha;

      // Update previous position for next frame
      this.px = x;
      this.py = y;
    };
  }

  /** Elegant night-sky palette: mostly cool whites + soft periwinkles, rare warm
   *  sparks. Saturation kept low (~35–55%) so stars feel like distant suns, not
   *  colored dots. */
  function randomColor() {
    const r = Math.random();
    let h;
    if (r < 0.7) {
      // 70% — cool whites / periwinkles (210–245°)
      h = 210 + Math.random() * 35;
    } else if (r < 0.92) {
      // 22% — soft lilac / dusky violet
      h = 250 + Math.random() * 30;
    } else {
      // 8% — rare warm spark (amber / soft red)
      h = (Math.random() < 0.5 ? 30 : 350) + Math.random() * 14 - 7;
    }
    const s = Math.random() * 22 + 32;   // 32–54% (was 88–100%)
    const l = Math.random() * 14 + 74;   // 74–88% (slightly brighter to stay visible)
    return `hsl(${h}, ${s}%, ${l}%)`;
  }

  function calculateNumStars(width, height, coresCount) {
    return calculateFullStarCount(width, height, coresCount, config.baseStars);
  }

  function starCountForCurrentPreference(width, height, coresCount) {
    const full = calculateNumStars(width, height, coresCount);
    if (prefersReducedMotion) return starCountForPreference(full, true);
    return defaultExperienceStarCount(full);
  }

  function snowflakeCountForCurrentPreference() {
    if (prefersReducedMotion) return snowflakeCountForPreference(true);
    return defaultExperienceSnowflakeCount();
  }

  function initStars(count) {
    stars = [];
    for (var i = 0; i < count; i++) {
      stars[i] = new Star(i);
    }
    // Bounded by construction: spawns-per-frame x mote lifetime. Never grows.
    dustPool = createDustPool(Math.max(1, dustCapacity(count)));
  }

  function initSnow() {
    snowflakes = [];
    const count = snowflakeCountForCurrentPreference();
    for (let i = 0; i < count; i++) {
      snowflakes.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: snowRadiusMin + Math.random() * (snowRadiusMax - snowRadiusMin),
        phase: Math.random() * Math.PI * 2,
        speed: snowSpeedMin + Math.random() * (snowSpeedMax - snowSpeedMin)
      });
    }
  }

  function initFireflies() {
    fireflies = [];
    const count = fireflyCountForPreference(prefersReducedMotion);
    const w = canvas.width;
    const h = canvas.height;
    for (let i = 0; i < count; i++) {
      fireflies.push({
        x: Math.random() * w,
        y: h * 0.55 + Math.random() * h * 0.42, // lower band, among trees / ground
        phase: Math.random() * Math.PI * 2,
        blinkPhase: Math.random() * Math.PI * 2,
        blinkSpeed: 0.6 + Math.random() * 1.2,
        drift: 6 + Math.random() * 10,
        scale: 0.7 + Math.random() * 0.9
      });
    }
  }

  function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    centerX = w / 2;
    centerY = h / 2;
    fl = w;
    const theme = getTheme();
    if (isTimeMode()) {
      // Living theme: stars (opacity modulated by the hour) + fireflies at dusk
      // + soft snow during daylight (drawTime gates each by the hour).
      numStars = starCountForCurrentPreference(w, h, cores);
      initStars(numStars);
      initFireflies();
      initSnow();
    } else if (theme === 'space') {
      numStars = starCountForCurrentPreference(w, h, cores);
      initStars(numStars);
    } else if (theme === 'garden') {
      initSnow();
    }
    // studio: no allocation, drawStudio() just clears the canvas
  }

  let resizeDebounceTimer = null;
  const RESIZE_DEBOUNCE_MS = 120;

  function scheduleResize() {
    if (resizeDebounceTimer !== null) {
      clearTimeout(resizeDebounceTimer);
    }
    resizeDebounceTimer = setTimeout(() => {
      resizeDebounceTimer = null;
      resizeCanvas();
    }, RESIZE_DEBOUNCE_MS);
  }

  function drawSpace() {
    // Subtle trail: fade each frame so it disappears completely (keeps look clean, no buildup)
    // Match --space-deep #141926 so the trail wash blends with the body bg.
    const trail = spaceTrailAlphaForPreference(prefersReducedMotion);
    c.fillStyle = `rgba(20, 25, 38, ${trail})`;
    c.fillRect(0, 0, canvas.width, canvas.height);
    // This path still accumulates via its own wash — it owes no compensation.
    setTrailCompensation(false);
    setDustEnabled(false); // this path still accumulates via its own wash
    starSpeedScale = starSpeedMultiplierForPreference(prefersReducedMotion);
    for (var i = 0; i < numStars; i++) {
      stars[i].show();
      stars[i].move();
    }
  }

  function drawSnowParticles() {
    const w = canvas.width;
    const h = canvas.height;
    const time = Date.now() * 0.001;
    const drift = prefersReducedMotion ? 0 : snowDriftAmplitude;
    const snowSpeedScale = snowSpeedMultiplierForPreference(prefersReducedMotion);

    for (let i = 0; i < snowflakes.length; i++) {
      const d = snowflakes[i];
      d.y += d.speed * snowSpeedScale;
      d.x += Math.sin(time + d.phase) * drift;
      if (d.y > h + d.r * 2) {
        d.y = -d.r * 2;
        d.x = Math.random() * w;
        d.phase = Math.random() * Math.PI * 2;
        d.r = snowRadiusMin + Math.random() * (snowRadiusMax - snowRadiusMin);
      }
      // Wrap horizontal position for continuous drift
      if (d.x < -d.r) d.x = w + d.r;
      if (d.x > w + d.r) d.x = -d.r;

      const size = d.r * 2;
      c.drawImage(snowSprite, d.x - d.r, d.y - d.r, size, size);
    }
  }

  function drawSnow() {
    c.clearRect(0, 0, canvas.width, canvas.height);
    drawSnowParticles();
  }

  function drawStudio() {
    // Studio (paper) theme: no canvas animation. Clear once per frame so any
    // leftover space trails or snowflakes fade out cleanly on theme switch.
    c.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawFireflies(weight) {
    const t = Date.now() * 0.001;
    const moving = !prefersReducedMotion;
    c.save();
    for (let i = 0; i < fireflies.length; i++) {
      const f = fireflies[i];
      const dx = moving ? Math.sin(t * 0.5 + f.phase) * f.drift : 0;
      const dy = moving ? Math.cos(t * 0.35 + f.phase) * f.drift * 0.5 : 0;
      const blink = moving ? 0.6 + 0.4 * Math.sin(t * f.blinkSpeed + f.blinkPhase) : 0.85;
      c.globalAlpha = Math.max(0, weight * blink);
      const size = FIREFLY_SPRITE_RADIUS * 2 * f.scale;
      c.drawImage(fireflySprite, f.x + dx - size / 2, f.y + dy - size / 2, size, size);
    }
    c.restore();
  }

  function drawTime() {
    const w = canvas.width;
    const h = canvas.height;
    const sp = sceneParamsAt(currentTimeHours());
    const dayScene = sp.sun >= sp.star; // daytime (garden) vs night (space)

    if (dayScene) {
      // Daytime: FULL clear every frame so snow renders as soft, soothing
      // snowflakes with no motion trails — exactly like the original garden snow.
      // (Stars are ~0 by day, so there's no trail to preserve.)
      c.clearRect(0, 0, w, h);
      if (sp.star > 0.01) {
        // Already cleared every frame before this change — nothing to repay.
        setTrailCompensation(compensateForClearedTrail(prefersReducedMotion, dayScene));
        setDustEnabled(false); // daylight sheds no stardust
        starSpeedScale = starSpeedMultiplierForPreference(prefersReducedMotion);
        c.save();
        c.globalAlpha = sp.star;
        for (var i = 0; i < numStars; i++) {
          stars[i].show();
          stars[i].move();
        }
        c.restore();
      }
      if (snowflakes.length && sp.sun > 0.01) {
        // Snow falls only in daylight; it fades in at dawn and out toward dusk.
        c.save();
        c.globalAlpha = Math.min(1, sp.sun);
        drawSnowParticles();
        c.restore();
      }
      return;
    }

    // Night: FULL clear every frame (same as the daytime path). A partial
    // `destination-out` erase never actually finished — multiplying 8-bit alpha
    // by 0.78 leaves pixels stuck at alpha 1 forever, so old streaks accumulated
    // into permanent ghost trails. The lingering glow that erase used to give is
    // now stardust: motes shed at the stars' past positions, fading on their own
    // age to exactly zero. Nothing is read back off the canvas, so nothing sticks.
    c.clearRect(0, 0, w, h);
    if (sp.star > 0.01) {
      // Default motion lost ~14 frames of accumulated glow here — and only here.
      // Reduced motion already erased at alpha 1 (a full clear), so it owes nothing.
      const compensate = compensateForClearedTrail(prefersReducedMotion, dayScene);
      setTrailCompensation(compensate);
      setDustEnabled(compensate);
      starSpeedScale = starSpeedMultiplierForPreference(prefersReducedMotion);
      // Dust sits behind the stars, and lags a frame (it is shed during show()).
      if (dustEnabled) drawDust(sp.star);
      c.save();
      c.globalAlpha = sp.star;
      for (var j = 0; j < numStars; j++) {
        stars[j].show();
        stars[j].move();
      }
      c.restore();
    } else {
      // Stars faded out entirely: dust is neither drawn nor aged, so retire it
      // rather than let it thaw at stale positions when the stars return.
      setDustEnabled(false);
    }
    if (sp.firefly > 0.01 && fireflies.length) {
      drawFireflies(sp.firefly);
    }
  }

  function draw() {
    frameCount++;
    if (isTimeMode()) {
      drawTime();
      return;
    }
    const theme = getTheme();
    if (theme === 'garden') {
      drawSnow();
    } else if (theme === 'studio') {
      drawStudio();
    } else {
      drawSpace();
    }
  }

  let rafId = null;

  function frame() {
    draw();
    if (document.visibilityState === 'visible') {
      rafId = window.requestAnimationFrame(frame);
    } else {
      rafId = null;
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && rafId === null) {
      rafId = window.requestAnimationFrame(frame);
    } else if (document.visibilityState === 'hidden' && rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  resizeCanvas();
  window.addEventListener('resize', scheduleResize);
  document.addEventListener('visibilitychange', onVisibilityChange);

  window.addEventListener('themechange', () => {
    if (isTimeMode()) {
      // Time mode fires themechange as the chrome flips garden/space at dawn/dusk.
      // Keep the pools (drawTime modulates star opacity; snow is always on); just
      // ensure they exist. Re-allocating on every flip would reset the scene.
      if (!stars.length || !snowflakes.length) resizeCanvas();
      return;
    }
    const theme = getTheme();
    if (theme === 'space') {
      snowflakes = [];
    } else if (theme === 'garden') {
      stars = [];
      numStars = 0;
    } else {
      // studio: drop both pools so we don't keep allocating idle objects
      snowflakes = [];
      stars = [];
      numStars = 0;
    }
    resizeCanvas();
  });

  rafId = window.requestAnimationFrame(frame);
}
