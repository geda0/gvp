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
      // + a constant gentle snow that's always there, every season.
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

  function drawTime() {
    // Stars fade with the hour (full at night → gone by midday); fireflies glow
    // at dusk/evening. We erase a fraction each frame (destination-out) instead of
    // washing the canvas dark — keeps motion-streak trails AND leaves the canvas
    // transparent so the interpolated sky (body background) shows through.
    const w = canvas.width;
    const h = canvas.height;
    const sp = sceneParamsAt(currentTimeHours());
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = `rgba(0, 0, 0, ${prefersReducedMotion ? 1 : 0.22})`;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';

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

    if (sp.firefly > 0.01 && fireflies.length) {
      drawFireflies(sp.firefly);
    }

    // Snow is always there — a constant gentle fall over day and night alike.
    if (snowflakes.length) {
      drawSnowParticles();
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
