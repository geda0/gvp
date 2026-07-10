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
 * The night trail, and why it lives in the colour channels.
 *
 * The original faded the canvas with `destination-out` + rgba(0,0,0,0.22), which
 * multiplies the ALPHA channel by 0.78 every frame. In 8-bit that rounds UP at the
 * bottom (2 * 0.78 = 1.56 -> 2), so alpha stalls at 2 and every pixel a star ever
 * crossed keeps a permanent veil. Measured on the live original: pixels stuck at
 * alpha 2 grew from 39% to 58% of the canvas in 24 seconds.
 *
 * Browser-verified: the SAME 0.78 fade applied to a COLOUR channel truncates and
 * reaches exactly 0 (frame 19). So the night canvas is painted opaque black, the
 * trail fades on colour with the identical 0.22 curve, and the canvas is composited
 * with `screen` — under which black is the identity, so the CSS sky behind shows
 * through untouched. Same decay curve, same look, and it actually ends.
 *
 * Daytime keeps `normal` blending: snow must alpha-composite over the garden scene,
 * not screen onto it (screen against a bright sky would blow the flakes out to white).
 */
/** What the original faded per frame. Kept only as the reference the budget is measured against. */
export const ORIGINAL_TRAIL_FADE_ALPHA = 0.22;

/**
 * How long a star's glow paints a single pixel — its "deposit". Measured from the
 * real projection over ~10k sampled stars (2 * glowRadius / screen-speed): p25 1.5,
 * median 3.1, p75 6.6 frames.
 *
 * THE RULE: the wake must not outlive the deposit that made it. At the original
 * 0.22 the trail took 18 frames to clear against a ~3-frame deposit, so glow piled
 * up roughly 6x faster than it drained — that is the accumulation.
 */
export const DEPOSIT_FRAMES = 3;

/**
 * Frames for a full-brightness pixel to fall to pure black under this fade.
 * Models the canvas exactly: the colour channel TRUNCATES (unlike alpha, which
 * rounds up and stalls at 2 — the residue bug), so this always terminates.
 */
export function trailFramesToClear(fadeAlpha, start = 255) {
  const keep = 1 - fadeAlpha;
  let v = start;
  let frames = 0;
  while (v > 0) {
    const next = Math.floor(v * keep);
    if (next === v) return Infinity; // would stall — cannot happen for fadeAlpha > 0
    v = next;
    frames++;
  }
  return frames;
}

/**
 * The GENTLEST fade that still clears within `frames` — i.e. the longest smear the
 * budget allows. Searching for the minimum keeps as much of the original's soft
 * trail as the rule permits, instead of over-fading it away.
 */
export function fadeAlphaForClearFrames(frames) {
  for (let a = 0.001; a <= 1; a += 0.001) {
    const alpha = Math.round(a * 1000) / 1000;
    if (trailFramesToClear(alpha) <= frames) return alpha;
  }
  return 1;
}

/** Derived, never hand-tuned: the softest trail that cannot outlive its deposit. */
export const TRAIL_FADE_ALPHA = fadeAlphaForClearFrames(DEPOSIT_FRAMES);

export const NIGHT_BLEND_MODE = 'screen';
export const DAY_BLEND_MODE = 'normal';

/** Reduced motion erases the frame outright — those users get stars, never a trail. */
export function trailFadeAlpha(prefersReducedMotion) {
  return prefersReducedMotion ? 1 : TRAIL_FADE_ALPHA;
}

export function blendModeForScene({ dayScene }) {
  return dayScene ? DAY_BLEND_MODE : NIGHT_BLEND_MODE;
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

  // Star + streak sprites, baked once per palette colour. The original built a
  // fresh createRadialGradient PER STAR PER FRAME and a createLinearGradient per
  // streak — measured 67,920 + 65,546 gradient objects per second at ~1130 stars.
  // The gradient STOPS below are identical to the originals, so the sprites are a
  // faithful cache: same picture, no allocation. (Same trick this file already used
  // for snowflakes.)
  const STAR_SPRITE_RADIUS = 64;
  const STREAK_SPRITE_W = 64;
  const STREAK_SPRITE_H = 4;
  const STREAK_THICKNESS = 1.5;
  const STREAK_MAX_DIST = 150;

  const starSprites = [];
  const streakSprites = [];
  for (let i = 0; i < STAR_PALETTE_SIZE; i++) {
    const color = starPalette[i];

    const glowSprite = document.createElement('canvas');
    glowSprite.width = STAR_SPRITE_RADIUS * 2;
    glowSprite.height = STAR_SPRITE_RADIUS * 2;
    const gc = glowSprite.getContext('2d');
    const rg = gc.createRadialGradient(
      STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, 0,
      STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS
    );
    rg.addColorStop(0, color);
    rg.addColorStop(1, 'transparent');
    gc.fillStyle = rg;
    gc.beginPath();
    gc.arc(STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, STAR_SPRITE_RADIUS, 0, Math.PI * 2);
    gc.fill();
    starSprites.push(glowSprite);

    const streakSprite = document.createElement('canvas');
    streakSprite.width = STREAK_SPRITE_W;
    streakSprite.height = STREAK_SPRITE_H;
    const sc2 = streakSprite.getContext('2d');
    const lg = sc2.createLinearGradient(0, 0, STREAK_SPRITE_W, 0);
    lg.addColorStop(0, 'transparent');
    lg.addColorStop(1, streakColor(color));
    sc2.fillStyle = lg;
    sc2.fillRect(0, 0, STREAK_SPRITE_W, STREAK_SPRITE_H);
    streakSprites.push(streakSprite);
  }

  function Star() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.z = Math.random() * canvas.width;
    this.colorIndex = paletteColorIndex();
    this.size = Math.random() / 2;
    this.px = null;
    this.py = null;

    this.move = function () {
      var speed =
        (config.baseSpeed + (canvas.width - this.z) / canvas.width * 4) *
        starSpeedScale;
      this.z = this.z - speed;

      if (this.z <= 0 || this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
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

      // Motion streaks: default only (reduced-motion users get stars without streaks).
      // The baked strip carries the same transparent->colour fade the per-frame
      // linear gradient did, drawn along px->x. One drawImage, zero allocation.
      if (
        !prefersReducedMotion &&
        this.px !== null &&
        this.py !== null
      ) {
        const dx = x - this.px;
        const dy = y - this.py;
        const dist = Math.hypot(dx, dy);
        if (dist > 0 && dist < STREAK_MAX_DIST) {
          c.save();
          c.translate(this.px, this.py);
          c.rotate(Math.atan2(dy, dx));
          c.drawImage(
            streakSprites[this.colorIndex],
            0, -STREAK_THICKNESS / 2, dist, STREAK_THICKNESS
          );
          c.restore();
        }
      }

      // Draw the star: the baked radial sprite, scaled to the original radius.
      const radius = s * (1.5 + this.glow / 10);
      if (radius > 0) {
        c.drawImage(
          starSprites[this.colorIndex],
          x - radius, y - radius, radius * 2, radius * 2
        );
      }

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

  /**
   * The streak is the star's colour at low opacity. Deriving it by rewriting
   * `hsl(` -> `hsla(` on the formatted string fails SILENTLY the day randomColor()
   * emits the modern space-separated form (`hsl(210 40% 80%)`) — canvas ignores an
   * invalid fillStyle rather than throwing, so the streaks would just vanish.
   * Parse the components instead, and refuse to guess.
   */
  function streakColor(hsl, alpha = 0.38) {
    const m = /hsl\(\s*([\d.]+)\s*(?:,\s*|\s+)([\d.]+)%\s*(?:,\s*|\s+)([\d.]+)%\s*\)/.exec(hsl);
    if (!m) throw new Error(`starfield: cannot derive streak colour from "${hsl}"`);
    return `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, ${alpha})`;
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
      stars[i] = new Star();
    }
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
    // A resize clears the canvas, so the night trail's opaque base is gone.
    backdropDirty = true;
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

  /** Current CSS blend mode on the canvas element; only touched when it changes. */
  let blendMode = null;
  /** True when the canvas needs its opaque black base repainted (night only). */
  let backdropDirty = true;

  function applyBlendMode(mode) {
    if (blendMode === mode) return;
    blendMode = mode;
    canvas.style.mixBlendMode = mode;
    // Leaving night (or entering it) invalidates the opaque base.
    backdropDirty = true;
  }

  /**
   * The night trail needs an opaque base so the fade works on colour, not alpha.
   * Repainted only on entry to night and after a resize — never per frame, or the
   * trail would be erased every frame.
   */
  function ensureOpaqueBackdrop() {
    if (!backdropDirty) return;
    backdropDirty = false;
    const prev = c.globalCompositeOperation;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.globalCompositeOperation = prev;
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

    applyBlendMode(blendModeForScene({ dayScene }));

    if (dayScene) {
      // Daytime: FULL clear every frame so snow renders as soft, soothing
      // snowflakes with no motion trails — exactly like the original garden snow.
      // (Stars are ~0 by day, so there's no trail to preserve.)
      c.clearRect(0, 0, w, h);
      if (sp.star > 0.01) {
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

    // Night: the star trail, faded on the COLOUR channels of an opaque black
    // canvas. `destination-out` faded ALPHA, which rounds up at the bottom and
    // strands every touched pixel at alpha 2 forever (the growing veil). Colour
    // truncates, so the identical 0.22 curve now actually reaches black — and the
    // canvas is `screen`-blended, under which black is the identity, so the
    // interpolated sky shows through exactly as before. Fireflies at dusk; no snow.
    ensureOpaqueBackdrop();
    c.fillStyle = `rgba(0, 0, 0, ${trailFadeAlpha(prefersReducedMotion)})`;
    c.fillRect(0, 0, w, h);
    if (sp.star > 0.01) {
      starSpeedScale = starSpeedMultiplierForPreference(prefersReducedMotion);
      c.save();
      c.globalAlpha = sp.star;
      for (var j = 0; j < numStars; j++) {
        stars[j].show();
        stars[j].move();
      }
      c.restore();
    }
    if (sp.firefly > 0.01 && fireflies.length) {
      drawFireflies(sp.firefly);
    }
  }

  function draw() {
    if (isTimeMode()) {
      drawTime();
      return;
    }
    // Legacy (non-time) themes composite normally; only the night trail needs screen.
    applyBlendMode(DAY_BLEND_MODE);
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
