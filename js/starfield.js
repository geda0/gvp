// starfield.js - Theme-aware canvas (starfield | snow)
import {
  STARFIELD_DEFAULT_EXPERIENCE,
  calculateFullStarCount,
  starCountForPreference,
  snowflakeCountForPreference,
  spaceTrailAlphaForPreference,
  defaultExperienceStarCount,
  defaultExperienceSnowflakeCount,
  starSpeedMultiplierForPreference,
  snowSpeedMultiplierForPreference
} from './starfield-prefs.js'

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

  // ----- Pyramids theme: small camels drifting across the horizon -----
  let camels = [];
  const CAMEL_COUNT_DESKTOP = 7;
  const CAMEL_COUNT_MOBILE = 4;
  const camelSpeedMin = 0.06;   // px/frame at base scale — very slow ("at a distance")
  const camelSpeedMax = 0.22;
  const camelScaleMin = 0.6;
  const camelScaleMax = 1.05;

  // Pre-rendered camel sprite (24×14 px logical, drawn at smaller sizes per
  // camel). One drawImage per camel per frame — same cheap pattern as snow.
  const CAMEL_SPRITE_W = 24;
  const CAMEL_SPRITE_H = 14;
  const camelSprite = document.createElement('canvas');
  camelSprite.width = CAMEL_SPRITE_W;
  camelSprite.height = CAMEL_SPRITE_H;
  {
    const cs = camelSprite.getContext('2d');
    // Dark warm silhouette — reads as a camel against the warm sand band.
    cs.fillStyle = 'rgba(58, 32, 12, 0.92)';
    // Body
    cs.beginPath();
    cs.ellipse(11, 9, 6, 2, 0, 0, Math.PI * 2);
    cs.fill();
    // Hump 1 (rear, taller)
    cs.beginPath();
    cs.ellipse(9, 7, 3, 2.4, 0, Math.PI, 0);
    cs.fill();
    // Hump 2 (front, smaller — dromedary-ish overlap reads at small sizes)
    cs.beginPath();
    cs.ellipse(13, 7, 2.4, 1.9, 0, Math.PI, 0);
    cs.fill();
    // Neck up + head
    cs.beginPath();
    cs.moveTo(16, 7.5);
    cs.lineTo(19, 4.5);
    cs.lineTo(20.5, 4.5);
    cs.lineTo(21.5, 5.2);
    cs.lineTo(20, 6);
    cs.lineTo(17, 8.5);
    cs.closePath();
    cs.fill();
    // Legs — 4 short verticals
    cs.fillRect(6.4, 10.5, 1, 3);
    cs.fillRect(9, 10.5, 1, 3);
    cs.fillRect(13, 10.5, 1, 3);
    cs.fillRect(15.5, 10.5, 1, 3);
  }

  function camelCountForViewport(w) {
    if (w < 768) return CAMEL_COUNT_MOBILE;
    return CAMEL_COUNT_DESKTOP;
  }

  function initCamels() {
    camels = [];
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;
    const count = camelCountForViewport(w);
    // Camels walk along the horizon — CSS .pyramid-sand sits at bottom 22vh
    // and .pyramid-horizon sits just above it. Spread camels across that
    // band so they read as a caravan in the middle distance, not on top of
    // the foreground sand.
    const horizonTop = h * 0.66;
    const horizonBottom = h * 0.74;
    for (let i = 0; i < count; i++) {
      const scale = camelScaleMin + Math.random() * (camelScaleMax - camelScaleMin);
      camels.push({
        x: Math.random() * w,
        y: horizonTop + Math.random() * (horizonBottom - horizonTop),
        scale,
        // Smaller (farther) camels move slower — depth cue.
        speed: (camelSpeedMin + Math.random() * (camelSpeedMax - camelSpeedMin)) * scale,
        phase: Math.random() * Math.PI * 2,
        bob: 0.12 + Math.random() * 0.18   // vertical bob amplitude in px
      });
    }
    // Sort back-to-front (smaller scale = farther) so closer camels render on top.
    camels.sort((a, b) => a.scale - b.scale);
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

  function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    centerX = w / 2;
    centerY = h / 2;
    fl = w;
    const theme = getTheme();
    if (theme === 'space') {
      numStars = starCountForCurrentPreference(w, h, cores);
      initStars(numStars);
    } else if (theme === 'garden') {
      initSnow();
    } else if (theme === 'pyramids') {
      initCamels();
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
    // Match the new --space-deep #0c111c so the trail wash blends with the body bg.
    const trail = spaceTrailAlphaForPreference(prefersReducedMotion);
    c.fillStyle = `rgba(12, 17, 28, ${trail})`;
    c.fillRect(0, 0, canvas.width, canvas.height);
    starSpeedScale = starSpeedMultiplierForPreference(prefersReducedMotion);
    for (var i = 0; i < numStars; i++) {
      stars[i].show();
      stars[i].move();
    }
  }

  function drawSnow() {
    c.clearRect(0, 0, canvas.width, canvas.height);
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

  function drawStudio() {
    // Studio (paper) theme: no canvas animation. Clear once per frame so any
    // leftover space trails or snowflakes fade out cleanly on theme switch.
    c.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawPyramids() {
    c.clearRect(0, 0, canvas.width, canvas.height);
    if (camels.length === 0) return;
    const w = canvas.width;
    const time = Date.now() * 0.001;
    // Reduced-motion users get a static caravan — same composition, no drift.
    const motion = prefersReducedMotion ? 0 : 1;
    for (let i = 0; i < camels.length; i++) {
      const camel = camels[i];
      camel.x -= camel.speed * motion;
      // Wrap left → right with a small randomized gap so they don't all loop in lockstep.
      if (camel.x + CAMEL_SPRITE_W * camel.scale < 0) {
        camel.x = w + Math.random() * (w * 0.15);
      }
      // Subtle vertical bob — sells "walking" without doing per-leg animation.
      const yOffset = motion ? Math.sin(time * 2.2 + camel.phase) * camel.bob : 0;
      const drawW = CAMEL_SPRITE_W * camel.scale;
      const drawH = CAMEL_SPRITE_H * camel.scale;
      c.drawImage(camelSprite, camel.x, camel.y + yOffset, drawW, drawH);
    }
  }

  function draw() {
    const theme = getTheme();
    if (theme === 'garden') {
      drawSnow();
    } else if (theme === 'studio') {
      drawStudio();
    } else if (theme === 'pyramids') {
      drawPyramids();
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
    const theme = getTheme();
    if (theme === 'space') {
      snowflakes = [];
      camels = [];
    } else if (theme === 'garden') {
      stars = [];
      numStars = 0;
      camels = [];
    } else if (theme === 'pyramids') {
      stars = [];
      numStars = 0;
      snowflakes = [];
    } else {
      // studio: drop all pools so we don't keep allocating idle objects
      snowflakes = [];
      stars = [];
      numStars = 0;
      camels = [];
    }
    resizeCanvas();
  });

  rafId = window.requestAnimationFrame(frame);
}
