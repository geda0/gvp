// starfield.js - Theme-aware canvas (starfield | snow)
export function initStarfield(canvasId, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const c = canvas.getContext('2d');
  const getTheme = options.getTheme || (() => 'space');

  const config = {
    baseSpeed: 0.1,
    baseStars: 717
  };

  let stars = [];
  let numStars = 0;
  let centerX, centerY, fl;
  const cores = window.navigator.hardwareConcurrency || 4;

  // Snow state (garden theme)
  let snowflakes = [];
  const snowCount = 200;
  const snowSpeedMin = 0.6;
  const snowSpeedMax = 1.8;
  const snowRadiusMin = 1;
  const snowRadiusMax = 3;
  const snowDriftAmplitude = 0.3;

  function Star() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.z = Math.random() * canvas.width;
    this.color = randomColor();
    this.size = Math.random() / 2;
    this.px = null;
    this.py = null;

    this.move = function () {
      var speed = config.baseSpeed + (canvas.width - this.z) / canvas.width * 4;
      this.z = this.z - speed;

      if (this.z <= 0 || this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
        this.z = canvas.width;
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.color = randomColor();
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

      // Draw motion streak if previous position exists and distance is reasonable
      if (this.px !== null && this.py !== null) {
        const dist = Math.hypot(x - this.px, y - this.py);
        if (dist < 150) {
          // Create linear gradient along the streak: transparent at tail, star color at head
          const streakGradient = c.createLinearGradient(this.px, this.py, x, y);
          // Convert HSL color to HSLA with opacity (hsl(360, 100%, 50%) -> hsla(360, 100%, 50%, 0.5))
          const colorWithOpacity = this.color.replace('hsl(', 'hsla(').replace(')', ', 0.58)');
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

  function randomColor() {
    return 'hsl(' + Math.random() * 360 + ', 100%, ' + (Math.random() * 22 + 56) + '%)';
  }

  function calculateNumStars(width, height, cores) {
    const area = width * height;
    const scaleFactor = cores / 4;
    return Math.floor((area / (1920 * 1080)) * config.baseStars * scaleFactor);
  }

  function initStars(count) {
    stars = [];
    for (var i = 0; i < count; i++) {
      stars[i] = new Star();
    }
  }

  function initSnow() {
    snowflakes = [];
    for (let i = 0; i < snowCount; i++) {
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
    if (getTheme() === 'space') {
      numStars = calculateNumStars(w, h, cores);
      initStars(numStars);
    } else {
      initSnow();
    }
  }

  function drawSpace() {
    // Subtle trail: fade each frame so it disappears completely (keeps look clean, no buildup)
    // Dark navy tint for a richer space background (matches --bg-primary #060c1a = rgb(6, 12, 26))
    c.fillStyle = 'rgba(3, 6, 12, 0.59)';
    c.fillRect(0, 0, canvas.width, canvas.height);
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
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const drift = prefersReducedMotion ? 0 : snowDriftAmplitude;

    for (let i = 0; i < snowflakes.length; i++) {
      const d = snowflakes[i];
      d.y += d.speed;
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

      const gradient = c.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
      gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.5)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      c.beginPath();
      c.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      c.fillStyle = gradient;
      c.fill();
    }
  }

  function draw() {
    if (getTheme() === 'garden') {
      drawSnow();
    } else {
      drawSpace();
    }
  }

  function update() {
    draw();
    window.requestAnimationFrame(update);
  }

  function throttle(func, limit) {
    let lastFunc;
    let lastRan;
    return function () {
      const context = this;
      const args = arguments;
      if (!lastRan) {
        func.apply(context, args);
        lastRan = Date.now();
      } else {
        clearTimeout(lastFunc);
        lastFunc = setTimeout(function () {
          if ((Date.now() - lastRan) >= limit) {
            func.apply(context, args);
            lastRan = Date.now();
          }
        }, limit - (Date.now() - lastRan));
      }
    };
  }

  resizeCanvas();
  if (getTheme() === 'space') {
    numStars = calculateNumStars(canvas.width, canvas.height, cores);
    initStars(numStars);
  } else {
    initSnow();
  }
  window.addEventListener('resize', resizeCanvas);

  window.addEventListener('themechange', () => {
    if (getTheme() === 'space') {
      snowflakes = [];
    } else {
      stars = [];
      numStars = 0;
    }
    resizeCanvas();
  });

  const throttledUpdate = throttle(update, 1000 / 120);
  throttledUpdate();
}
