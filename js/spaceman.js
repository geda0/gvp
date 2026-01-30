// spaceman.js - AI Spaceman character controller

class Spaceman {
  constructor(containerId, dataUrl) {
    this.container = document.getElementById(containerId);
    this.state = 'idle';
    this.messageIndex = 0;
    this.data = null;
    this.typingTimeout = null;
    this.messageTimeout = null;
    this.idleTimer = null;
    this.clickCount = 0;
    this.clickTimer = null;
    this.lastMousePos = { x: 0, y: 0 };
    this.isMouseInViewport = true;

    this.init(dataUrl);
  }

  async init(dataUrl) {
    // Load message data
    try {
      const response = await fetch(dataUrl);
      this.data = await response.json();
    } catch (e) {
      console.error('Failed to load spaceman data:', e);
      this.data = this.getDefaultData();
    }

    this.render();
    this.bindEvents();
    this.bindInteractivity();
    this.startMessageCycle();
    this.startIdleAnimations();
  }

  render() {
    this.container.innerHTML = `
      <div class="spaceman" id="spaceman">
        <div class="thought-bubble" id="thoughtBubble">
          <span class="thought-text" id="thoughtText"></span>
          <span class="cursor">|</span>
        </div>
        <div class="thought-tail">
          <span class="bubble-dot dot-1"></span>
          <span class="bubble-dot dot-2"></span>
          <span class="bubble-dot dot-3"></span>
        </div>
        <div class="spaceman-body">
          <div class="helmet">
            <div class="visor">
              <div class="visor-reflection"></div>
              <div class="eyes">
                <span class="eye left-eye"></span>
                <span class="eye right-eye"></span>
              </div>
            </div>
          </div>
          <div class="arm left-arm"></div>
          <div class="arm right-arm"></div>
          <div class="torso">
            <div class="chest-panel">
              <span class="light light-1"></span>
              <span class="light light-2"></span>
            </div>
          </div>
          <div class="jetpack">
            <div class="pack"></div>
          </div>
          <div class="legs">
            <div class="leg left-leg"></div>
            <div class="leg right-leg"></div>
          </div>
          <div class="flames-container">
            <div class="flame left-flame">
              <div class="flame-inner"></div>
            </div>
            <div class="flame right-flame">
              <div class="flame-inner"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.elements = {
      spaceman: document.getElementById('spaceman'),
      thoughtBubble: document.getElementById('thoughtBubble'),
      thoughtText: document.getElementById('thoughtText')
    };
  }

  bindEvents() {
    // Hover reaction
    this.elements.spaceman.addEventListener('mouseenter', () => {
      this.react('hover');
    });

    // Click reaction (jetpack boost)
    this.elements.spaceman.addEventListener('click', () => {
      this.react('click');
      this.elements.spaceman.classList.add('boost');
      setTimeout(() => {
        this.elements.spaceman.classList.remove('boost');
      }, 600);
    });

    // Long idle detection
    this.resetIdleTimer();
    document.addEventListener('mousemove', () => this.resetIdleTimer());
  }

  resetIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.data?.reactions?.longIdle) {
        this.typeMessage(this.data.reactions.longIdle);
      }
    }, 30000); // 30 seconds of no movement
  }

  setState(newState) {
    if (this.state === newState) return;

    this.state = newState;
    this.messageIndex = 0;

    // Clear existing cycles
    clearTimeout(this.typingTimeout);
    clearTimeout(this.messageTimeout);

    // Animate state transition
    this.elements.spaceman.classList.add('state-change');
    setTimeout(() => {
      this.elements.spaceman.classList.remove('state-change');
    }, 500);

    // Start new message cycle
    this.startMessageCycle();
  }

  startMessageCycle() {
    const stateData = this.data?.states?.[this.state];
    if (!stateData) return;

    const message = stateData.messages[this.messageIndex];
    this.typeMessage(message, stateData.typingSpeed);

    // Schedule next message
    this.messageTimeout = setTimeout(() => {
      this.messageIndex = (this.messageIndex + 1) % stateData.messages.length;
      this.startMessageCycle();
    }, stateData.messageDelay + (message.length * stateData.typingSpeed));
  }

  typeMessage(message, speed = 50) {
    // Clear current message
    this.elements.thoughtText.textContent = '';
    clearTimeout(this.typingTimeout);

    let charIndex = 0;

    const type = () => {
      if (charIndex < message.length) {
        this.elements.thoughtText.textContent += message[charIndex];
        charIndex++;
        this.typingTimeout = setTimeout(type, speed);
      }
    };

    type();
  }

  react(reactionType) {
    const reaction = this.data?.reactions?.[reactionType];
    if (reaction) {
      // Temporarily show reaction, then resume cycle
      clearTimeout(this.typingTimeout);
      clearTimeout(this.messageTimeout);

      this.typeMessage(reaction, 30);

      this.messageTimeout = setTimeout(() => {
        this.startMessageCycle();
      }, 2000);
    }
  }

  bindInteractivity() {
    const spaceman = this.elements.spaceman;
    const helmet = spaceman.querySelector('.helmet');
    const jetpack = spaceman.querySelector('.jetpack');
    const eyes = spaceman.querySelectorAll('.eye');

    // --- Eye Tracking ---
    document.addEventListener('mousemove', (e) => {
      this.lastMousePos = { x: e.clientX, y: e.clientY };
      this.updateEyePosition(e.clientX, e.clientY);
    });

    // --- Mouse Leave Viewport ---
    document.addEventListener('mouseleave', () => {
      this.isMouseInViewport = false;
      eyes.forEach(eye => eye.classList.add('searching'));
    });

    document.addEventListener('mouseenter', () => {
      this.isMouseInViewport = true;
      eyes.forEach(eye => eye.classList.remove('searching'));
    });

    // --- Helmet Click ---
    helmet.addEventListener('click', (e) => {
      e.stopPropagation();
      helmet.classList.add('flash');
      this.triggerBlink();
      this.typeMessage("*visor sparkles* ✨", 30);
      setTimeout(() => helmet.classList.remove('flash'), 300);
      setTimeout(() => this.startMessageCycle(), 2000);
    });

    // --- Jetpack Click ---
    jetpack.addEventListener('click', (e) => {
      e.stopPropagation();
      const spacemanBody = spaceman.querySelector('.spaceman-body');
      spacemanBody.classList.add('burst');
      this.typeMessage("WHOOOOSH! 🔥", 20);
      setTimeout(() => spacemanBody.classList.remove('burst'), 400);
      setTimeout(() => this.startMessageCycle(), 2000);
    });

    // --- Rapid Click Detection ---
    spaceman.addEventListener('click', () => {
      this.clickCount++;

      clearTimeout(this.clickTimer);
      this.clickTimer = setTimeout(() => {
        if (this.clickCount >= 5) {
          this.triggerDizzy();
        }
        this.clickCount = 0;
      }, 1000);
    });
  }

  updateEyePosition(mouseX, mouseY) {
    const spaceman = this.elements.spaceman;
    const rect = spaceman.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 4;

    const deltaX = mouseX - centerX;
    const deltaY = mouseY - centerY;

    let direction = '';
    const threshold = 50;

    if (Math.abs(deltaY) < threshold && Math.abs(deltaX) < threshold) {
      direction = '';
    } else if (deltaY < -threshold && deltaX < -threshold) {
      direction = 'look-top-left';
    } else if (deltaY < -threshold && deltaX > threshold) {
      direction = 'look-top-right';
    } else if (deltaY > threshold && deltaX < -threshold) {
      direction = 'look-bottom-left';
    } else if (deltaY > threshold && deltaX > threshold) {
      direction = 'look-bottom-right';
    } else if (deltaY < -threshold) {
      direction = 'look-up';
    } else if (deltaY > threshold) {
      direction = 'look-down';
    } else if (deltaX < -threshold) {
      direction = 'look-left';
    } else if (deltaX > threshold) {
      direction = 'look-right';
    }

    const eyes = spaceman.querySelectorAll('.eye');
    const lookClasses = [
      'look-left', 'look-right', 'look-up', 'look-down',
      'look-top-left', 'look-top-right',
      'look-bottom-left', 'look-bottom-right'
    ];

    eyes.forEach(eye => {
      lookClasses.forEach(cls => eye.classList.remove(cls));
      if (direction) {
        eye.classList.add(direction);
      }
    });
  }

  triggerBlink() {
    const eyes = this.elements.spaceman.querySelectorAll('.eye');
    eyes.forEach(eye => {
      eye.classList.add('blink');
      setTimeout(() => eye.classList.remove('blink'), 150);
    });
  }

  triggerDizzy() {
    const spaceman = this.elements.spaceman;
    spaceman.classList.add('dizzy');
    this.typeMessage("Woah... so many clicks! 😵‍💫", 30);
    setTimeout(() => spaceman.classList.remove('dizzy'), 800);
    setTimeout(() => this.startMessageCycle(), 3000);
  }

  startIdleAnimations() {
    // Random blink every 3-7 seconds
    const scheduleBlink = () => {
      const delay = 3000 + Math.random() * 4000;
      setTimeout(() => {
        if (this.isMouseInViewport) {
          this.triggerBlink();
        }
        scheduleBlink();
      }, delay);
    };
    scheduleBlink();

    // Random wave every 15-30 seconds
    const scheduleWave = () => {
      const delay = 15000 + Math.random() * 15000;
      setTimeout(() => {
        if (this.state === 'idle') {
          this.triggerWave();
        }
        scheduleWave();
      }, delay);
    };
    scheduleWave();
  }

  triggerWave() {
    const spaceman = this.elements.spaceman;
    spaceman.classList.add('wave');
    setTimeout(() => spaceman.classList.remove('wave'), 1800);
  }

  getDefaultData() {
    return {
      states: {
        idle: { messages: ["Hello! Welcome!"], typingSpeed: 50, messageDelay: 3000 },
        playground: { messages: ["Exploring projects..."], typingSpeed: 50, messageDelay: 3000 },
        portfolio: { messages: ["Professional work..."], typingSpeed: 50, messageDelay: 3000 },
        home: { messages: ["Back home!"], typingSpeed: 50, messageDelay: 3000 }
      },
      reactions: { hover: "Hi!", click: "Wheee!", longIdle: "..." }
    };
  }

  destroy() {
    clearTimeout(this.typingTimeout);
    clearTimeout(this.messageTimeout);
    clearTimeout(this.idleTimer);
    clearTimeout(this.clickTimer);
    this.container.innerHTML = '';
  }
}

// Export for module usage
export function initSpaceman(containerId, dataUrl) {
  return new Spaceman(containerId, dataUrl);
}

export { Spaceman };
