// starfield.js - Theme-aware canvas (starfield | rain)
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

  // Rain state (garden theme)
  let rainDrops = [];
  const rainCount = 180;
  const rainSpeed = 4;
  const rainLength = 18;

  function Star() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.z = Math.random() * canvas.width;
    this.color = randomColor();
    this.size = Math.random() / 2;

    this.move = function () {
      var speed = config.baseSpeed + (canvas.width - this.z) / canvas.width * 4;
      this.z = this.z - speed;

      if (this.z <= 0 || this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
        this.z = canvas.width;
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.color = randomColor();
      }
    };

    this.show = function () {
      var x, y, s;
      x = (this.x - centerX) * (fl / this.z);
      x = x + centerX;

      y = (this.y - centerY) * (fl / this.z);
      y = y + centerY;

      s = this.size * (fl / this.z);

      this.glow = (canvas.width - this.z) / canvas.width * 12;

      var gradient = c.createRadialGradient(x, y, 0, x, y, s * (1.5 + this.glow / 10));
      gradient.addColorStop(0, this.color);
      gradient.addColorStop(1, 'transparent');

      c.beginPath();
      c.fillStyle = gradient;
      c.arc(x, y, s * (1.5 + this.glow / 10), 0, Math.PI * 2);
      c.fill();
    };
  }

  function randomColor() {
    return 'hsl(' + Math.random() * 360 + ', 100%, ' + (Math.random() * 20 + 50) + '%)';
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

  function initRain() {
    rainDrops = [];
    for (let i = 0; i < rainCount; i++) {
      rainDrops.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        len: rainLength + Math.random() * 12,
        speed: rainSpeed + Math.random() * 3
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
      initRain();
    }
  }

  function drawSpace() {
    // Subtle trail: fade each frame so it disappears completely (keeps look clean, no buildup)
    c.fillStyle = 'rgba(0, 0, 0, 0.49)';
    c.fillRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < numStars; i++) {
      stars[i].show();
      stars[i].move();
    }
  }

  function drawRain() {
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    c.lineWidth = 1.5;
    const w = canvas.width;
    const h = canvas.height;
    for (let i = 0; i < rainDrops.length; i++) {
      const d = rainDrops[i];
      d.y += d.speed;
      if (d.y > h + d.len) {
        d.y = -d.len;
        d.x = Math.random() * w;
      }
      c.beginPath();
      c.moveTo(d.x, d.y);
      c.lineTo(d.x, d.y + d.len);
      c.stroke();
    }
  }

  function draw() {
    if (getTheme() === 'garden') {
      drawRain();
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
    initRain();
  }
  window.addEventListener('resize', resizeCanvas);

  window.addEventListener('themechange', () => {
    if (getTheme() === 'space') {
      rainDrops = [];
    } else {
      stars = [];
      numStars = 0;
    }
    resizeCanvas();
  });

  const throttledUpdate = throttle(update, 1000 / 120);
  throttledUpdate();
}
