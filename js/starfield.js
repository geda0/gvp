// starfield.js - Canvas animation (fully isolated)
export function initStarfield(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const c = canvas.getContext('2d');

  // Configuration
  const config = {
    baseSpeed: 0.1,
    baseStars: 717
  };

  let stars = [];
  let numStars = 0;
  let centerX, centerY, fl;
  const cores = window.navigator.hardwareConcurrency || 4;

  // Star class
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

  function initStars(numStars) {
    stars = [];
    for (var i = 0; i < numStars; i++) {
      stars[i] = new Star();
    }
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    centerX = canvas.width / 2;
    centerY = canvas.height / 2;
    fl = canvas.width;
    numStars = calculateNumStars(canvas.width, canvas.height, cores);
    initStars(numStars);
  }

  function draw() {
    c.fillStyle = 'rgba(0, 0, 0, 0.25)';
    c.fillRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < numStars; i++) {
      stars[i].show();
      stars[i].move();
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

  // Initialize
  resizeCanvas();
  numStars = calculateNumStars(canvas.width, canvas.height, cores);
  console.log(`Number of stars: ${numStars}`);
  initStars(numStars);
  window.addEventListener('resize', resizeCanvas);

  const throttledUpdate = throttle(update, 1000 / 120);
  throttledUpdate();
}
