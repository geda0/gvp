// spaceman.js - Spaceman character controller (theme-aware messages)
import { getTheme } from './theme.js';

const DEFAULTS = {
  typingSpeed: 50,
  reactionSpeed: 30,
  messageDelay: 3000,
  idleTimeout: 30000,
  blinkInterval: { min: 3000, max: 6000 },
  waveInterval: { min: 20000, max: 40000 },
  boostDuration: 600,
  stateChangeDuration: 500,
  blinkDuration: 150,
  waveDuration: 1500
};

const DEFAULT_DATA = {
  states: {
    idle: { messages: ['Hello! Welcome!'], typingSpeed: 50, messageDelay: 3000 },
    playground: { messages: ['Exploring projects...'], typingSpeed: 50, messageDelay: 3000 },
    portfolio: { messages: ['Professional work...'], typingSpeed: 50, messageDelay: 3000 },
    home: { messages: ['Back home!'], typingSpeed: 50, messageDelay: 3000 }
  },
  reactions: { hover: 'Hi!', click: 'Wheee!', longIdle: '...' }
};

class Spaceman {
  constructor(containerId, dataUrl) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.state = 'idle';
    this.messageIndex = 0;
    this.data = null;
    this.resume = null;
    this.context = null;
    this.elements = {};

    this._timers = {
      typing: null,
      message: null,
      idle: null,
      blink: null,
      wave: null
    };

    /** Resolves when the spaceman has finished loading data and rendering (safe to query #spaceman in DOM). */
    this.ready = this._init(dataUrl);
  }

  async _init(dataUrl) {
    this.data = await this._loadData(dataUrl);
    try {
      const res = await fetch('/resume/resume.json');
      if (res.ok) this.resume = await res.json();
    } catch (_) {
      this.resume = null;
    }
    this._render();
    this._bindEvents();
    this._startIdleAnimations();
    this._startMessageCycle();
    this._themeChangeHandler = () => this._onThemeChange();
    window.addEventListener('themechange', this._themeChangeHandler);
  }

  _getThemeData() {
    const theme = getTheme();
    const themed = this.data?.themeMessages?.[theme];
    if (themed) return { states: themed.states, reactions: themed.reactions };
    return { states: this.data?.states, reactions: this.data?.reactions };
  }

  _getMergedMessages(state) {
    const { states } = this._getThemeData();
    const stateData = states?.[state];
    const base = stateData?.messages ? [...stateData.messages] : [];
    if (!this.resume) return base;

    const r = this.resume;
    if (state === 'portfolio' && r.experience?.length) {
      r.experience.slice(0, 5).forEach(ex => {
        const verb = ex.workVerb || 'on';
        base.push(`At ${ex.company}, Marwan worked ${verb} ${ex.role}.`);
        if (ex.highlights?.[0]) base.push(`${ex.company}: ${ex.highlights[0]}`);
      });
    }
    if (state === 'playground' && r.skills?.length) {
      const skill = r.skills[Math.floor(Math.random() * r.skills.length)];
      const skillPhrase = this._getSkillPhrase(skill);
      base.push(skillPhrase);
      if (r.projects?.length) {
        const proj = r.projects[Math.floor(Math.random() * Math.min(3, r.projects.length))];
        base.push(proj.blurb ? `${proj.title} — ${proj.blurb}` : proj.title);
      }
    }
    if ((state === 'home' || state === 'idle') && r.summary) {
      base.push(r.summary);
    }
    return base;
  }

  _getSkillPhrase(skill) {
    const phrases = {
      'SaaS': 'Marwan builds SaaS platforms.',
      'Full-stack': 'Marwan builds full-stack applications.',
      'Video Platform': 'Marwan builds video platforms.',
      'Data-intensive systems': 'Marwan builds data-intensive systems.'
    };
    return phrases[skill] ?? `Marwan builds with ${skill}.`;
  }

  _getProjectMessage() {
    if (!this.context?.projectTitle) return null;
    if (this.context.projectId && this.resume?.projects) {
      const proj = this.resume.projects.find(p => p.id === this.context.projectId);
      if (proj?.callout) return proj.callout;
    }
    const desc = this.context.projectDescription || '';
    const short = desc.replace(/<[^>]+>/g, '').trim().slice(0, 60);
    return short ? `That's ${this.context.projectTitle} — ${short}…` : `That's ${this.context.projectTitle}.`;
  }

  _getNextMessage() {
    const messages = this._getMergedMessages(this.state);
    if (!messages.length) return { message: null, fromMergedArray: false };
    const useProject =
      (this.state === 'playground' || this.state === 'portfolio') && this.context?.projectTitle;
    if (useProject && Math.random() < 0.35) {
      const projectMsg = this._getProjectMessage();
      if (projectMsg) return { message: projectMsg, fromMergedArray: false };
    }
    const msg = messages[this.messageIndex % messages.length];
    return { message: msg, fromMergedArray: true };
  }

  _onThemeChange() {
    this._clearTimer('typing');
    this._clearTimer('message');
    this.messageIndex = 0;
    this._startMessageCycle();
  }

  async _loadData(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn('Spaceman: Using defaults', e.message);
      return DEFAULT_DATA;
    }
  }

  _render() {
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
          <div class="jetpack">
            <div class="pack"></div>
            <div class="flames-container">
              <div class="flame left-flame"><div class="flame-inner"></div></div>
              <div class="flame right-flame"><div class="flame-inner"></div></div>
            </div>
          </div>
          <div class="hero-cape" aria-hidden="true">
            <div class="cape-cloth"></div>
          </div>
          <div class="hero-head" aria-hidden="true">
            <div class="hero-face"></div>
            <div class="hero-hair"></div>
            <div class="hero-mask"></div>
            <div class="hero-eyes">
              <span class="eye left-eye"></span>
              <span class="eye right-eye"></span>
            </div>
          </div>
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
          <div class="legs">
            <div class="leg left-leg"></div>
            <div class="leg right-leg"></div>
          </div>
        </div>
      </div>
    `;

    this.elements = {
      spaceman: document.getElementById('spaceman'),
      text: document.getElementById('thoughtText')
    };
  }

  _bindEvents() {
    const { spaceman } = this.elements;
    if (!spaceman) return;

    spaceman.addEventListener('mouseenter', () => this._react('hover'));
    spaceman.addEventListener('click', () => {
      this._react('click');
      this._triggerBoost();
    });

    this._resetIdleTimer();
    document.addEventListener('mousemove', () => this._resetIdleTimer());
  }

  setContext(ctx) {
    this.context = ctx && (ctx.projectId || ctx.projectTitle) ? ctx : null;
  }

  // Public API
  setState(newState) {
    if (this.state === newState) return;

    this.state = newState;
    this.messageIndex = 0;

    this._clearTimer('typing');
    this._clearTimer('message');

    const { spaceman } = this.elements;
    if (spaceman) {
      spaceman.classList.add('state-change');
      setTimeout(() => spaceman.classList.remove('state-change'), DEFAULTS.stateChangeDuration);
    }

    this._startMessageCycle();
  }

  // Messaging
  _startMessageCycle() {
    const { states } = this._getThemeData();
    const stateData = states?.[this.state];
    const messages = this._getMergedMessages(this.state);
    if (!messages.length) return;

    const { message, fromMergedArray } = this._getNextMessage();
    if (!message) return;

    const speed = stateData?.typingSpeed || DEFAULTS.typingSpeed;
    const delay = stateData?.messageDelay || DEFAULTS.messageDelay;

    this._typeMessage(message, speed);

    this._timers.message = setTimeout(() => {
      if (fromMergedArray) {
        this.messageIndex = (this.messageIndex + 1) % Math.max(1, messages.length);
      }
      this._startMessageCycle();
    }, delay + (message.length * speed));
  }

  _typeMessage(message, speed = DEFAULTS.typingSpeed) {
    const { text } = this.elements;
    if (!text) return;

    this._clearTimer('typing');
    text.textContent = '';

    let i = 0;
    const type = () => {
      if (i < message.length) {
        text.textContent += message[i++];
        this._timers.typing = setTimeout(type, speed);
      }
    };
    type();
  }

  _react(type) {
    const { reactions } = this._getThemeData();
    const reaction = reactions?.[type];
    if (!reaction) return;

    this._clearTimer('typing');
    this._clearTimer('message');

    this._typeMessage(reaction, DEFAULTS.reactionSpeed);

    this._timers.message = setTimeout(() => {
      this._startMessageCycle();
    }, 2000);
  }

  // Idle animations
  _startIdleAnimations() {
    this._scheduleBlink();
    this._scheduleWave();
  }

  _scheduleBlink() {
    const { min, max } = DEFAULTS.blinkInterval;
    const delay = min + Math.random() * (max - min);

    this._timers.blink = setTimeout(() => {
      this._triggerBlink();
      this._scheduleBlink();
    }, delay);
  }

  _scheduleWave() {
    const { min, max } = DEFAULTS.waveInterval;
    const delay = min + Math.random() * (max - min);

    this._timers.wave = setTimeout(() => {
      if (this.state === 'idle') this._triggerWave();
      this._scheduleWave();
    }, delay);
  }

  _triggerBlink() {
    const eyes = this.elements.spaceman?.querySelectorAll('.eye');
    eyes?.forEach(eye => {
      eye.classList.add('blink');
      setTimeout(() => eye.classList.remove('blink'), DEFAULTS.blinkDuration);
    });
  }

  _triggerWave() {
    const { spaceman } = this.elements;
    if (!spaceman) return;
    spaceman.classList.add('wave');
    setTimeout(() => spaceman.classList.remove('wave'), DEFAULTS.waveDuration);
  }

  _triggerBoost() {
    const { spaceman } = this.elements;
    if (!spaceman) return;
    spaceman.classList.add('boost');
    setTimeout(() => spaceman.classList.remove('boost'), DEFAULTS.boostDuration);
  }

  _resetIdleTimer() {
    this._clearTimer('idle');
    this._timers.idle = setTimeout(() => {
      const { reactions } = this._getThemeData();
      const msg = reactions?.longIdle;
      if (msg) this._typeMessage(msg);
    }, DEFAULTS.idleTimeout);
  }

  // Timer utilities
  _clearTimer(name) {
    if (this._timers[name]) {
      clearTimeout(this._timers[name]);
      this._timers[name] = null;
    }
  }

  _clearAllTimers() {
    Object.keys(this._timers).forEach(k => this._clearTimer(k));
  }

  destroy() {
    this._clearAllTimers();
    window.removeEventListener('themechange', this._themeChangeHandler);
    if (this.container) this.container.innerHTML = '';
  }
}

/**
 * Initializes the spaceman. Returns a Promise that resolves with the Spaceman instance
 * once data is loaded and the hero is rendered. Await before initializing positioning.
 */
export function initSpaceman(containerId, dataUrl) {
  const instance = new Spaceman(containerId, dataUrl);
  return instance.ready ? instance.ready.then(() => instance) : Promise.resolve(instance);
}

export { Spaceman };
