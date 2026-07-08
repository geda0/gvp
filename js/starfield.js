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
export const STREAK_TAIL_FRAMES = 8;
/** Longest tail we draw — a fast or respawned star must not smear across the screen. */
export const STREAK_MAX_DIST = 150;
/** Sub-pixel tails are invisible; skip the draw entirely. */
export const STREAK_MIN_DIST = 1;
export const STREAK_THICKNESS = 1.5;
/**
 * Per-frame brightness. The old renderer got its brightness for free by letting
 * ~14 frames of glow pile up on an uncleared canvas. On a cleared canvas each
 * star is drawn exactly once, so the single pass has to carry the same weight:
 * a slightly wider glow and a stronger streak head restore the night sky's
 * density without ever accumulating.
 */
export const STAR_GLOW_SCALE = 2.2;
export const STREAK_ALPHA = 0.62;

/** Tail length for a star that moved `frameDelta` px this frame. */
export function streakLength(frameDelta, tailFrames = STREAK_TAIL_FRAMES) {
  return Math.min(frameDelta * tailFrames, STREAK_MAX_DIST);
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

  /** Called by each draw path before the star loop. */
  function setTrailCompensation(compensate) {
    starGlowScale = compensate ? STAR_GLOW_SCALE : 1;
    starTailFrames = compensate ? STREAK_TAIL_FRAMES : 1;
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
  const STREAK_SPRITE_H = 4;

  const starSprites = [];
  const streakSprites = [];
  for (let i = 0; i < STAR_PALETTE_SIZE; i++) {
    const color = starPalette[i];

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

    // Streak strip: transparent at the tail (x=0), star colour at the head (x=W).
    // Drawn rotated/scaled onto the px→x segment, so the tail fade is preserved.
    const streakSprite = document.createElement('canvas');
    streakSprite.width = STREAK_SPRITE_W;
    streakSprite.height = STREAK_SPRITE_H;
    const sc2 = streakSprite.getContext('2d');
    const lg = sc2.createLinearGradient(0, 0, STREAK_SPRITE_W, 0);
    lg.addColorStop(0, 'transparent');
    lg.addColorStop(1, color.replace('hsl(', 'hsla(').replace(')', `, ${STREAK_ALPHA})`));
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
      // The baked strip sprite carries the tail→head fade, so no gradient per frame.
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
          // so the sprite's transparent→colour fade lands head-on at (x, y).
          c.save();
          c.translate(x - (dx / dist) * tail, y - (dy / dist) * tail);
          c.rotate(Math.atan2(dy, dx));
          c.drawImage(
            streakSprites[this.colorIndex],
            0, -STREAK_THICKNESS / 2, tail, STREAK_THICKNESS
          );
          c.restore();
        }
      }

      // Draw the star: scale the baked glow sprite to this star's radius.
      const radius = s * (1.5 + this.glow / 10) * starGlowScale;
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
    // into permanent ghost trails. Motion is already conveyed by each star's
    // per-frame streak sprite, so nothing is lost and the canvas stays
    // transparent for the interpolated sky behind it.
    c.clearRect(0, 0, w, h);
    if (sp.star > 0.01) {
      // Default motion lost ~14 frames of accumulated glow here — and only here.
      // Reduced motion already erased at alpha 1 (a full clear), so it owes nothing.
      setTrailCompensation(compensateForClearedTrail(prefersReducedMotion, dayScene));
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
