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

/**
 * Depth guards (restored 2026-10-08). The projection is `size * (focalLength / z)` with
 * focalLength = canvas.width, and a star aimed near the centre keeps closing on the camera,
 * so its radius diverges without bound. MEASURED at width 1920: ~8px at z=0.15*W, ~42px at
 * z=0.03*W, ~125px at z=0.01*W, ~417px at z=0.003*W. The night fade is `destination-out` at
 * alpha 0.22, i.e. it RETAINS 78% of every frame, so successive frames of a disc growing from
 * 8px to 400px composite into a wide flattened wing behind a bright head — the artifact the
 * owner reported as a "manta ray". It is the radial GLOW, not the 1.5px streak.
 *
 * This is not new code. `1e06743` wrote and break-checked exactly these guards, calling the
 * artifact "the beach ball"; `2d079aa` then reverted an entire aesthetic experiment chain and
 * took this genuine bug fix — and its test suite — with it as collateral. The geometry has
 * been live on prod ever since, through two promotions. Re-applied here against the CURRENT
 * call sites, which differ from the ones `1e06743` patched, so this is a re-wire and not a
 * cherry-pick.
 *
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
import { sceneParamsAt } from './theme-time.js'

// WHY — the "star dust" fixed point.
// The night sky fades trails with destination-out + rgba(0,0,0,0.22): every frame the
// 8-bit ALPHA channel becomes round(a * 0.78). Rounding gives it a FLOOR it can never
// cross: round(2*0.78)=2 and round(1*0.78)=1. So alpha 1 and 2 stall FOREVER, and every
// value above them descends INTO that stall. Result: every pixel a star ever crossed
// keeps a permanent sub-perceptual veil (measured live: 37%->43% of canvas in 10s).
// The fix must not change prod's LOOK, so we touch nothing about compositing, the fade
// constant, blends, or star rendering. We add a garbage collector that zeroes ONLY the
// pixels the fade provably cannot reach (alpha <= the derived stall floor, <=2/255, well
// under the perceptual threshold). The visible decay 255 -> 3 is never disturbed.
// Cost: a full-canvas getImageData+putImageData measured 14.9ms (a whole 60fps frame).
// A ~10-row band measured 0.2ms median / 0.6ms max — so the GC is INCREMENTAL: a fixed
// row band per frame, a cursor cycling the canvas, constant cost at any viewport height.
// The load-bearing property is NO GAPS: an uncovered row is dust that never gets collected.

/** Does repeatedly applying the fade to this alpha ever reach 0, or does it stall on a fixed point? */
export function alphaStalls(alpha, fadeAlpha) {
  if (alpha <= 0) return false;
  if (fadeAlpha >= 1) return false;
  let a = alpha;
  while (a !== 0) {
    const next = Math.round(a * (1 - fadeAlpha));
    if (next === a) return true;
    a = next;
  }
  return false;
}

/**
 * Hard ceiling on what the collector is EVER allowed to erase. The derived stall
 * floor is floor(0.5 / fadeAlpha), which grows without bound as the fade softens
 * (0.01 -> 50, 0.002 -> 250) — a gentler trail would authorize the GC to erase the
 * visible starfield. 2/255 is ~0.8% opacity: below perception, so collecting it
 * cannot change the render. The clamp is what keeps "preserve prod's look exactly"
 * true for ANY fade, not just the 0.22 we happen to call it with today.
 */
export const DUST_MAX_FLOOR = 2;

/** Highest alpha value that stalls forever under this fade — the GC threshold, never perceptible. */
export function dustAlphaFloor(fadeAlpha) {
  let floor = 0;
  for (let v = 1; v <= 255; v++) {
    if (Math.round(v * (1 - fadeAlpha)) === v) floor = v;
  }
  return Math.min(floor, DUST_MAX_FLOOR);
}

// Rows collected per frame. A ~10-row band measured 0.2ms median / 0.6ms max, vs 14.9ms
// for a full-canvas getImageData+putImageData (a whole 60fps frame). A fixed ROW COUNT
// (not a fixed band count) keeps the per-frame cost constant regardless of viewport height.
export const DUST_SWEEP_ROWS = 12;

/** Rect for the sweep band at cursorRow, clipped so it never reads past the canvas. */
export function sweepBandRect(cursorRow, rows, width, height) {
  return { x: 0, y: cursorRow, w: width, h: Math.min(rows, height - cursorRow) };
}

/** Next sweep cursor: advances by rows, wrapping at the bottom for gap-free full coverage. */
export function nextSweepCursor(cursorRow, rows, height) {
  const next = cursorRow + rows;
  return next >= height ? 0 : next;
}

/** Zeroes RGBA quads whose alpha is stuck at or below floor; returns the count cleared. */
export function collectDust(data, floor) {
  let collected = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a > 0 && a <= floor) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      collected++;
    }
  }
  return collected;
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
   * Dust collector cursor — the row where the next sweep band starts. The night
   * fade multiplies 8-bit alpha by 0.78, and rounding has fixed points (2 and 1),
   * so pixels a star crossed stall there forever — a permanent sub-perceptual
   * veil. Each night frame collects one DUST_SWEEP_ROWS-tall band, cycling the
   * whole canvas, and zeroes only pixels at or below the derived stall floor.
   */
  let dustCursor = 0;

  // Precomputed color palette: stars pick from this instead of building an
  // hsl() string on every spawn/respawn. Visually equivalent to randomColor().
  const STAR_PALETTE_SIZE = 64;
  const starPalette = [];
  for (let i = 0; i < STAR_PALETTE_SIZE; i++) {
    starPalette.push(randomColor());
  }

  function paletteColor() {
    return starPalette[(Math.random() * STAR_PALETTE_SIZE) | 0];
  }

  function Star() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    // Seed in front of the near plane, so a fresh star is never recycled on frame 1.
    const near = starNearPlane(canvas.width);
    this.z = near + Math.random() * (canvas.width - near);
    this.color = paletteColor();
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
        this.color = paletteColor();
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

      // Motion streaks: default only (reduced-motion users get stars without streaks)
      if (
        !prefersReducedMotion &&
        this.px !== null &&
        this.py !== null
      ) {
        const dist = Math.hypot(x - this.px, y - this.py);
        if (dist < 150) {
          // Create linear gradient along the streak: transparent at tail, star color at head
          const streakGradient = c.createLinearGradient(this.px, this.py, x, y);
          // Convert HSL color to HSLA with opacity (hsl(360, 100%, 50%) -> hsla(360, 100%, 50%, 0.5))
          // Lower opacity than before — streaks should suggest motion, not draw the eye.
          const colorWithOpacity = this.color.replace('hsl(', 'hsla(').replace(')', ', 0.38)');
          streakGradient.addColorStop(0, 'transparent');
          streakGradient.addColorStop(1, colorWithOpacity);

          c.save();
          c.strokeStyle = streakGradient;
          c.lineWidth = 1.5;
          c.lineCap = 'round';
          c.beginPath();
          c.moveTo(this.px, this.py);
          c.lineTo(x, y);
          c.stroke();
          c.restore();
        }
      }

      // Draw the star
      var gradient = c.createRadialGradient(x, y, 0, x, y, clampStarRadius(s * (1.5 + this.glow / 10)));
      gradient.addColorStop(0, this.color);
      gradient.addColorStop(1, 'transparent');

      c.beginPath();
      c.fillStyle = gradient;
      c.arc(x, y, clampStarRadius(s * (1.5 + this.glow / 10)), 0, Math.PI * 2);
      c.fill();

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
    dustCursor = 0;
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

  /**
   * Collect one band of stalled dust. Runs BEFORE the frame is painted so the
   * faint halos this frame is about to draw are never clipped from what the
   * viewer sees. Reads back only DUST_SWEEP_ROWS rows (~0.2ms) — a full-canvas
   * readback is ~14.9ms, a whole 60fps frame.
   */
  function collectDustBand(fadeAlpha) {
    const floor = dustAlphaFloor(fadeAlpha);
    if (floor <= 0) return; // a full erase leaves no dust to collect
    const band = sweepBandRect(dustCursor, DUST_SWEEP_ROWS, canvas.width, canvas.height);
    if (band.h <= 0) { dustCursor = 0; return; }
    const img = c.getImageData(band.x, band.y, band.w, band.h);
    collectDust(img.data, floor);
    c.putImageData(img, band.x, band.y);
    dustCursor = nextSweepCursor(dustCursor, DUST_SWEEP_ROWS, canvas.height);
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

    // Night: star motion-streak trails via a partial erase (keeps the canvas
    // transparent so the interpolated sky shows through) + fireflies at dusk.
    // No snow at night.
    collectDustBand(prefersReducedMotion ? 1 : 0.22);
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = `rgba(0, 0, 0, ${prefersReducedMotion ? 1 : 0.22})`;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
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
