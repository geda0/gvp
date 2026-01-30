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
    this.startMessageCycle();
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
                <span class="eye left"></span>
                <span class="eye right"></span>
              </div>
            </div>
          </div>
          <div class="torso">
            <div class="arm left-arm"></div>
            <div class="arm right-arm"></div>
            <div class="chest-panel">
              <span class="light light-1"></span>
              <span class="light light-2"></span>
            </div>
          </div>
          <div class="jetpack">
            <div class="pack"></div>
            <div class="flame left-flame">
              <div class="flame-inner"></div>
            </div>
            <div class="flame right-flame">
              <div class="flame-inner"></div>
            </div>
          </div>
          <div class="legs">
            <div class="leg left-leg"></div>
            <div class="leg right-leg"></div>
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
    this.container.innerHTML = '';
  }
}

// Export for module usage
export function initSpaceman(containerId, dataUrl) {
  return new Spaceman(containerId, dataUrl);
}

export { Spaceman };
