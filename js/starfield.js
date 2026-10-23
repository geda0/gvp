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
  snowSpeedMultiplierForPreference,
  precipitationCountForPreference,
  precipitationSpeedMultiplierForPreference,
  defaultExperiencePrecipitationCount
} from './starfield-prefs.js'
import { sceneParamsAt } from './theme-time.js'

/**
 * The SPACE renderer below (starSpeedScale .. randomColor) is the ORIGINAL starfield, restored
 * verbatim from c7a09b6 (2026-05-19, before the team-tactics kit) at the owner's request on
 * 2026-10-23: every later "fix" to the stars - sprites, depth guards, comet tails, streak
 * widths, culling, star-count caps - changed how the sky looked and moved, and the owner
 * judged the original better. test/starfield-original.test.mjs pins it to that revision.
 */

/**
 * Rain/hail streak length (precipitation only - the stars draw the original streaks above).
 * Kept from before the restore so precipitation renders exactly as it did.
 */
export const STREAK_TAIL_FRAMES = 8;
/** Longest precipitation streak - a fast or respawned particle must not smear across the screen. */
export const STREAK_MAX_DIST = 150;

/** Streak length for a particle that moved `frameDelta` px this frame. */
export function streakLength(frameDelta, tailFrames = STREAK_TAIL_FRAMES) {
  return Math.min(frameDelta * tailFrames, STREAK_MAX_DIST);
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

  // Daytime precipitation (ADR-0016). ONE HOMOGENEOUS POOL: every particle in it is the
  // current kind, and the per-kind branch is hoisted OUT of the draw loop. A per-particle
  // `kind` tag would mean an unpredictable branch and a polymorphic property read 183-260
  // times a frame on a value that is constant across the whole array - which is exactly the
  // class of per-particle work M1 spent six slices removing. Three arrays would mean two
  // always-empty guards per frame, forever.
  //
  // The renderer knows a KIND STRING and nothing about why: no months, no hemispheres, no
  // hail odds. js/theme.js writes `data-precipitation` and this reads it per frame, the
  // same way it already reads `data-time-hours`.
  let precipitation = [];
  let precipitationKind = 'snow';
  const snowSpeedMin = 0.6;
  const snowSpeedMax = 1.8;
  const snowRadiusMin = 1;
  const snowRadiusMax = 3;
  const snowDriftAmplitude = 0.3;
  // Rain falls far faster than snow and almost straight down; its streak length is DERIVED
  // from the per-frame displacement (see drawRainParticles) rather than being a second knob,
  // so one speed controls both and they cannot disagree.
  const rainSpeedMin = 9;
  const rainSpeedMax = 16;
  const rainTailFrames = 2.2;
  const RAIN_STROKE = 'rgba(176, 206, 232, 0.55)';
  const RAIN_WIDTH = 1.1;
  // Hail is slower than rain, heavier than snow, and its tail is shorter and brighter.
  const hailSpeedMin = 6;
  const hailSpeedMax = 10;
  const hailRadiusMin = 1.6;
  const hailRadiusMax = 3.2;
  const hailTailFrames = 1.1;
  const HAIL_STROKE = 'rgba(226, 240, 252, 0.5)';
  const HAIL_WIDTH = 1.3;

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

  // Hail pellet sprite, 8px. No two sprite kinds share a height, so a test can tell them
  // apart by size; test/precipitation-render.test.mjs asserts it.
  const HAIL_SPRITE_SIZE = 8;
  const hailSprite = document.createElement('canvas');
  hailSprite.width = HAIL_SPRITE_SIZE;
  hailSprite.height = HAIL_SPRITE_SIZE;
  {
    const hc = hailSprite.getContext('2d');
    const hr = HAIL_SPRITE_SIZE / 2;
    const hg = hc.createRadialGradient(hr * 0.7, hr * 0.7, 0, hr, hr, hr);
    hg.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    hg.addColorStop(0.55, 'rgba(214, 234, 250, 0.8)');
    hg.addColorStop(1, 'rgba(188, 214, 236, 0)');
    hc.fillStyle = hg;
    hc.beginPath();
    hc.arc(hr, hr, hr, 0, Math.PI * 2);
    hc.fill();
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

  function paletteColor() {
    return starPalette[(Math.random() * STAR_PALETTE_SIZE) | 0];
  }

  function Star() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.z = Math.random() * canvas.width;
    this.color = paletteColor();
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
      var gradient = c.createRadialGradient(x, y, 0, x, y, s * (1.5 + this.glow / 10));
      gradient.addColorStop(0, this.color);
      gradient.addColorStop(1, 'transparent');

      c.beginPath();
      c.fillStyle = gradient;
      c.arc(x, y, s * (1.5 + this.glow / 10), 0, Math.PI * 2);
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

  function precipitationCountForCurrentPreference(kind) {
    if (prefersReducedMotion) return precipitationCountForPreference(kind, true);
    return defaultExperiencePrecipitationCount(kind);
  }

  /** The kind js/theme.js decided, read per frame like the hour already is. */
  function currentPrecipitationKind() {
    const raw = document.documentElement.dataset.precipitation;
    return raw === 'snow' || raw === 'rain' || raw === 'hail' ? raw : 'rain';
  }

  function initStars(count) {
    stars = [];
    for (var i = 0; i < count; i++) {
      stars[i] = new Star();
    }
  }

  /**
   * Seed the pool for one kind.
   *
   * THE SNOW BRANCH'S RANDOM DRAWS ARE FROZEN: five values, in the order x, y, r, phase,
   * speed, with no shared pre-roll before the branch. scripts/qa/starfield-ab-draws.mjs
   * replays the whole render under a seeded Math.random, so ONE extra or reordered draw
   * here shifts every subsequent particle and the harness reports a full-stream difference
   * for a change that is visually nothing. Rain and hail seed in their own branches, after,
   * so they consume from the stream only when they are the active kind.
   *
   * Per-kind object literals rather than one union shape with unused fields - each draw
   * loop then sees a single hidden class, and a union would have forced the snow literal to
   * change, which the paragraph above forbids.
   */
  function initPrecipitation(kind) {
    precipitationKind = kind;
    precipitation = [];
    const count = precipitationCountForCurrentPreference(kind);
    if (kind === 'rain') {
      for (let i = 0; i < count; i++) {
        precipitation.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          speed: rainSpeedMin + Math.random() * (rainSpeedMax - rainSpeedMin)
        });
      }
      return;
    }
    if (kind === 'hail') {
      for (let i = 0; i < count; i++) {
        precipitation.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          r: hailRadiusMin + Math.random() * (hailRadiusMax - hailRadiusMin),
          speed: hailSpeedMin + Math.random() * (hailSpeedMax - hailSpeedMin)
        });
      }
      return;
    }
    for (let i = 0; i < count; i++) {
      precipitation.push({
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
      initPrecipitation(currentPrecipitationKind());
    } else if (theme === 'space') {
      numStars = starCountForCurrentPreference(w, h, cores);
      initStars(numStars);
    } else if (theme === 'garden') {
      initPrecipitation(currentPrecipitationKind());
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

  /**
   * Move and draw the pool. ONE dispatch per frame, not per particle: the kind is constant
   * across the whole array, so the branch is hoisted out of the loop exactly as `drift` and
   * `snowSpeedScale` already are.
   */
  function drawPrecipitationParticles() {
    if (precipitationKind === 'rain') return drawRainParticles();
    if (precipitationKind === 'hail') return drawHailParticles();
    return drawSnowParticles();
  }

  /**
   * Rain: ONE path, N moveTo/lineTo pairs, ONE stroke. Zero drawImage, zero gradients.
   *
   * Batching is right here precisely because rain is UNIFORM - one colour, one width - which
   * is why the star streak could not use it: every star has its own colour, hence a baked
   * per-colour sprite. (M1 rejected batching streaks-then-discs because it changes blend
   * order; that does not transfer, because rain and the star field never draw in the same
   * branch.)
   *
   * The tail is DERIVED from the per-frame displacement through the same `streakLength` the
   * stars use, so one knob - speed - controls how fast a drop falls AND how long it looks,
   * and the reduced-motion speed cut shortens the streaks for free.
   */
  function drawRainParticles() {
    const w = canvas.width;
    const h = canvas.height;
    const scale = precipitationSpeedMultiplierForPreference('rain', prefersReducedMotion);

    c.strokeStyle = RAIN_STROKE;
    c.lineWidth = RAIN_WIDTH;
    c.beginPath();
    for (let i = 0; i < precipitation.length; i++) {
      const drop = precipitation[i];
      const step = drop.speed * scale;
      drop.y += step;
      if (drop.y > h) {
        drop.y = -20;
        drop.x = Math.random() * w;
      }
      const tail = streakLength(step, rainTailFrames);
      c.moveTo(drop.x, drop.y - tail);
      c.lineTo(drop.x, drop.y);
    }
    c.stroke();
  }

  /** Hail: one batched stroke for the tails, plus one drawImage per pellet. */
  function drawHailParticles() {
    const w = canvas.width;
    const h = canvas.height;
    const scale = precipitationSpeedMultiplierForPreference('hail', prefersReducedMotion);

    c.strokeStyle = HAIL_STROKE;
    c.lineWidth = HAIL_WIDTH;
    c.beginPath();
    for (let i = 0; i < precipitation.length; i++) {
      const stone = precipitation[i];
      const step = stone.speed * scale;
      stone.y += step;
      if (stone.y > h + stone.r * 2) {
        stone.y = -stone.r * 2;
        stone.x = Math.random() * w;
      }
      const tail = streakLength(step, hailTailFrames);
      c.moveTo(stone.x, stone.y - tail);
      c.lineTo(stone.x, stone.y);
    }
    c.stroke();

    for (let i = 0; i < precipitation.length; i++) {
      const stone = precipitation[i];
      const size = stone.r * 2;
      c.drawImage(hailSprite, stone.x - stone.r, stone.y - stone.r, size, size);
    }
  }

  function drawSnowParticles() {
    const w = canvas.width;
    const h = canvas.height;
    const time = Date.now() * 0.001;
    const drift = prefersReducedMotion ? 0 : snowDriftAmplitude;
    const snowSpeedScale = snowSpeedMultiplierForPreference(prefersReducedMotion);

    for (let i = 0; i < precipitation.length; i++) {
      const d = precipitation[i];
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
    drawPrecipitationParticles();
  }

  function drawStudio() {
    // Studio (paper) theme: no canvas animation. Clear once per frame so any
    // leftover space trails or precipitation fade out cleanly on theme switch.
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
      // Daytime: FULL clear every frame so precipitation renders with no motion trails —
      // exactly like the original garden snow. Rain and hail draw their own streaks from
      // per-frame displacement rather than relying on an uncleared canvas.
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
      if (precipitation.length && sp.sun > 0.01) {
        // RE-SEED ON A KIND CHANGE, compared per frame rather than driven by an event: an
        // event-driven re-seed goes stale the moment anything sets the attribute without
        // dispatching - a QA override, devtools, a future module. A string compare per
        // frame is self-healing and costs one property read against the 183-plus draws this
        // frame already makes. Almost always invisible in practice: the kind can only
        // change at local midnight, when this daytime branch is not running at all.
        const wantKind = currentPrecipitationKind();
        if (wantKind !== precipitationKind) initPrecipitation(wantKind);
        // Precipitation falls only in daylight; it fades in at dawn and out toward dusk.
        c.save();
        c.globalAlpha = Math.min(1, sp.sun);
        drawPrecipitationParticles();
        c.restore();
      }
      return;
    }

    // Night: the ORIGINAL trail (c7a09b6). The original faded each frame with a translucent
    // wash in the page colour; here the canvas is transparent over the interpolated CSS sky,
    // so the same retention is applied as an erase instead: keep (1 - trail) of the last frame.
    // At the original trail alphas (0.59, and 0.66 for reduced motion) the 8-bit erase
    // CONVERGES - e.g. 255, 87, 30, 10, 3, 1, 0 at 0.66 - unlike the 0.22 erase that once left
    // pixels stuck at alpha 1 forever (pinned by test/starfield-trail-stall.test.mjs).
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = `rgba(0, 0, 0, ${spaceTrailAlphaForPreference(prefersReducedMotion)})`;
    c.fillRect(0, 0, w, h);
    c.restore();
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
      // Keep the pools (drawTime modulates star opacity and fades precipitation in and out
      // with the sun); just ensure they exist. Re-allocating on every flip would reset the
      // scene. The precipitation KIND is not handled here on purpose: an event-driven
      // re-seed goes stale the moment anything sets the attribute without dispatching, so
      // drawTime compares it per frame instead (ADR-0016 §3.2).
      if (!stars.length || !precipitation.length) resizeCanvas();
      return;
    }
    const theme = getTheme();
    if (theme === 'space') {
      precipitation = [];
    } else if (theme === 'garden') {
      stars = [];
      numStars = 0;
    } else {
      // studio: drop both pools so we don't keep allocating idle objects
      precipitation = [];
      stars = [];
      numStars = 0;
    }
    resizeCanvas();
  });

  rafId = window.requestAnimationFrame(frame);
}
