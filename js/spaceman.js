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
    idle: { messages: ['I\'m Marwan\'s digital assistant.'], typingSpeed: 50, messageDelay: 3000 },
    playground: { messages: ['Experimental projects and technical explorations.'], typingSpeed: 40, messageDelay: 4000 },
    portfolio: { messages: ['Professional experience and career journey.'], typingSpeed: 40, messageDelay: 4000 },
    home: { messages: ['I\'m Marwan\'s digital assistant.'], typingSpeed: 50, messageDelay: 3000 }
  },
  reactions: { hover: 'Hello.', click: 'Noted.', longIdle: 'Ready when you are.' }
};

class Spaceman {
  constructor(containerId, dataUrl) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.state = 'idle';
    this.messageIndex = 0;
    this._firstMessageShown = false;
    this.isQuiet = false;
    this.isStayingHero = false;
    this._stayPromptActive = false;
    this.isDetermined = false;
    this.data = null;
    this.resume = null;
    this.context = null;
    this._lastSpokenMessage = null;
    this._lastSpokenFromMergedArray = false;
    this._lastSpokenMergedIndex = -1;
    this.elements = {};
    this.positionController = null;

    this._timers = {
      typing: null,
      message: null,
      idle: null,
      blink: null,
      wave: null
    };
    this._clickTimeout = null;

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
      'Software Architecture': 'Marwan designs software architecture for scale.',
      'SaaS': 'Marwan builds SaaS platforms.',
      'Full-stack': 'Marwan builds full-stack applications.',
      'Video Platform': 'Marwan builds video platforms.',
      'Data-intensive systems': 'Marwan builds data-intensive systems.',
      'Cloud-native systems': 'Marwan builds cloud-native systems.',
      'Distributed services': 'Marwan builds distributed services.',
      'AWS': 'Marwan designs and delivers AWS-based systems.',
      'Kubernetes': 'Marwan delivers production workloads on Kubernetes.',
      'Terraform': 'Marwan automates cloud infrastructure with Terraform.'
    };
    return phrases[skill] ?? `Marwan builds with ${skill}.`;
  }

  _getProjectMessage() {
    if (!this.context?.projectTitle) return null;
    if (this.context.projectId && this.resume?.projects) {
      const proj = this.resume.projects.find(p => p.id === this.context.projectId);
      // When a card is open (determined), prefer a short value-add hint over repeating the card copy.
      if (this.isDetermined && proj?.heroHint) return proj.heroHint;

      // Otherwise (ambient browsing), keep messages short and avoid title duplication in Playground.
      if (!this.isDetermined && proj?.blurb) return proj.blurb;
    }
    const desc = this.context.projectDescription || '';
    const short = desc.replace(/<[^>]+>/g, '').trim().slice(0, 32);
    if (this.state === 'playground') return short ? `${short}…` : 'Click a card for details.'
    return short ? `${this.context.projectTitle} — ${short}…` : `${this.context.projectTitle}.`;
  }

  _getWelcomeMessage() {
    return 'Marwan Elgendy — software architect and full-stack engineer.';
  }

  _getNextMessage() {
    // Show welcome only once per session, and only when on home/idle (not in the middle of Playground or Portfolio)
    const showWelcome = !this._firstMessageShown && (this.state === 'idle' || this.state === 'home');
    if (showWelcome) {
      const welcome = this._getWelcomeMessage();
      return { message: welcome, fromMergedArray: false };
    }
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
    // Do not reset _firstMessageShown — welcome should only show on true first load, not after theme switch
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
      <div class="spaceman-outer">
        <div class="spaceman-quiet-menu" id="spacemanQuietMenu" role="menu" aria-label="Hero options" hidden>
          <button type="button" class="spaceman-quiet-menu-btn" data-action="stay" hidden>Stay here</button>
          <button type="button" class="spaceman-quiet-menu-btn" data-action="free" hidden>Free</button>
          <button type="button" class="spaceman-quiet-menu-btn" data-action="quiet">Enter quiet mode</button>
        </div>
        <div class="spaceman" id="spaceman">
        <div class="thought-stack">
        <div class="thought-bubble" id="thoughtBubble">
          <span class="thought-text" id="thoughtText"></span>
          <span class="cursor">|</span>
        </div>
        <div class="thought-tail">
          <span class="bubble-dot dot-1"></span>
          <span class="bubble-dot dot-2"></span>
          <span class="bubble-dot dot-3"></span>
        </div>
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
          <div class="hero-stay-anchor" aria-hidden="true">⚓</div>
        </div>
      </div>
      </div>
    `;

    this.elements = {
      spaceman: document.getElementById('spaceman'),
      text: document.getElementById('thoughtText'),
      quietMenu: document.getElementById('spacemanQuietMenu'),
      stayMenuBtn: document.querySelector('#spacemanQuietMenu [data-action="stay"]'),
      freeMenuBtn: document.querySelector('#spacemanQuietMenu [data-action="free"]'),
      quietMenuBtn: document.querySelector('#spacemanQuietMenu [data-action="quiet"]')
    };
    this._bindHeroMenu();
  }

  _bindHeroMenu() {
    const { quietMenu, stayMenuBtn, freeMenuBtn, quietMenuBtn } = this.elements;
    if (!quietMenu) return;

    const onMenuBtn = (e, fn) => {
      e.stopPropagation();
      fn.call(this);
    };

    stayMenuBtn?.addEventListener('click', (e) => onMenuBtn(e, this._confirmStayHere));
    freeMenuBtn?.addEventListener('click', (e) => onMenuBtn(e, this._confirmFreeHero));
    quietMenuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._stayPromptActive = false;
      this._clearStayVisual();
      this.positionController?.setStaying(false);
      this._hideHeroMenuUI();
      this.setQuietMode(true);
    });

    this._quietMenuOutsideClick = (e) => {
      if (quietMenu.hidden) return;
      if (quietMenu.contains(e.target) || this.elements.spaceman?.contains(e.target)) return;
      this._dismissHeroMenu();
    };
  }

  _openHeroMenu(mode) {
    const { quietMenu, stayMenuBtn, freeMenuBtn } = this.elements;
    if (!quietMenu || this.isQuiet) return;

    if (mode === 'after-drag') {
      if (stayMenuBtn) stayMenuBtn.hidden = false;
      if (freeMenuBtn) freeMenuBtn.hidden = true;
    } else if (mode === 'staying') {
      if (stayMenuBtn) stayMenuBtn.hidden = true;
      if (freeMenuBtn) freeMenuBtn.hidden = false;
    } else {
      if (stayMenuBtn) stayMenuBtn.hidden = true;
      if (freeMenuBtn) freeMenuBtn.hidden = true;
    }

    quietMenu.hidden = false;
    quietMenu.setAttribute('aria-hidden', 'false');
    document.addEventListener('click', this._quietMenuOutsideClick, true);
    document.addEventListener('keydown', this._quietMenuEscape);
  }

  _hideHeroMenuUI() {
    const { quietMenu } = this.elements;
    if (!quietMenu) return;
    quietMenu.hidden = true;
    quietMenu.setAttribute('aria-hidden', 'true');
    document.removeEventListener('click', this._quietMenuOutsideClick, true);
    document.removeEventListener('keydown', this._quietMenuEscape);
  }

  _dismissHeroMenu() {
    const hadStayPrompt = this._stayPromptActive;
    this._stayPromptActive = false;
    this._hideHeroMenuUI();
    if (hadStayPrompt) this.positionController?.declineStayAfterDrag();
  }

  _quietMenuEscape = (e) => {
    if (e.key === 'Escape') this._dismissHeroMenu();
  };

  _clearStayVisual() {
    this.isStayingHero = false;
    this.elements.spaceman?.classList.remove('hero-staying');
  }

  _confirmStayHere = () => {
    this._stayPromptActive = false;
    this.isStayingHero = true;
    this.elements.spaceman?.classList.add('hero-staying');
    this.positionController?.setStaying(true);
    this._hideHeroMenuUI();
  };

  _confirmFreeHero = () => {
    this._stayPromptActive = false;
    this._clearStayVisual();
    this.positionController?.setStaying(false);
    this._hideHeroMenuUI();
  };

  _onPositionDragStart(detail) {
    if (detail?.wasStaying) this._clearStayVisual();
  }

  _onPositionDragEnd(moved) {
    if (!moved || this.isQuiet) return;
    this._stayPromptActive = true;
    this._openHeroMenu('after-drag');
  }

  _bindEvents() {
    const { spaceman } = this.elements;
    if (!spaceman) return;

    spaceman.addEventListener('mouseenter', () => {
      if (!this.isQuiet) this._react('hover');
    });
    
    spaceman.addEventListener('click', () => {
      if (this.isQuiet) {
        this.setQuietMode(false);
        return;
      }
      const { quietMenu } = this.elements;
      const menuOpen = quietMenu && !quietMenu.hidden;
      if (menuOpen) {
        this._dismissHeroMenu();
        return;
      }
      if (this._clickTimeout) {
        clearTimeout(this._clickTimeout);
        this._clickTimeout = null;
        this._hideHeroMenuUI();
        this._react('click');
        this._triggerBoost();
      } else {
        this._clickTimeout = setTimeout(() => {
          this._clickTimeout = null;
          const mode = this.isStayingHero ? 'staying' : 'default';
          this._openHeroMenu(mode);
        }, 300);
      }
    });

    this._resetIdleTimer();
    document.addEventListener('mousemove', () => this._resetIdleTimer());
  }

  setContext(ctx) {
    this.context = ctx && (ctx.projectId || ctx.projectTitle) ? ctx : null;
  }

  /**
   * When determined, freeze the message cycle to avoid distraction.
   * Used when a project dialog is open and the context is explicit.
   */
  setDetermined(determined) {
    const next = Boolean(determined);
    if (this.isDetermined === next) return;
    this.isDetermined = next;
    // Always cancel in-flight typing/timers on transitions.
    // This prevents stale "project is open" messages from finishing after the dialog closes.
    this._clearTimer('typing');
    this._clearTimer('message');
    if (!next) {
      // After a dialog closes, resume from the next merged message (when applicable).
      // This avoids repeating the same line every close, even if the last spoken line
      // during the dialog wasn't part of the merged array.
      const messages = this._getMergedMessages(this.state);
      if (messages.length) {
        if (this._lastSpokenFromMergedArray && this._lastSpokenMergedIndex >= 0) {
          this.messageIndex = (this._lastSpokenMergedIndex + 1) % messages.length;
        } else {
          const current = messages[this.messageIndex % messages.length];
          if (current && current === this._lastSpokenMessage) {
          this.messageIndex = (this.messageIndex + 1) % messages.length;
          }
        }
      }
      this._startMessageCycle();
    }
  }

  /** Call after setContext when the project detail modal opens — surfaces the active project in the bubble. */
  announceProjectContext() {
    if (this.isQuiet) return;
    if (this.state !== 'playground' && this.state !== 'portfolio') return;
    const msg = this._getProjectMessage();
    if (!msg) return;
    this._clearTimer('typing');
    this._clearTimer('message');
    const { states } = this._getThemeData();
    const stateData = states?.[this.state];
    const speed = stateData?.typingSpeed || DEFAULTS.typingSpeed;
    this._typeMessage(msg, speed);
    if (this.isDetermined) return;
    const delay = stateData?.messageDelay || DEFAULTS.messageDelay;
    this._timers.message = setTimeout(() => {
      this._startMessageCycle();
    }, delay + msg.length * speed);
  }

  setPositionController(controller) {
    this.positionController = controller;
    controller?.setHooks({
      onDragStart: (detail) => this._onPositionDragStart(detail),
      onDragEnd: (moved) => this._onPositionDragEnd(moved)
    });
  }

  setQuietMode(quiet) {
    if (this.isQuiet === quiet) return;
    
    this.isQuiet = quiet;
    
    if (quiet) {
      // Stop all messaging and animations
      this._clearAllTimers();
      const { text } = this.elements;
      if (text) text.textContent = '';
      this._stayPromptActive = false;
      this._hideHeroMenuUI();
      this._clearStayVisual();
      if (this.positionController) {
        this.positionController.setStaying(false);
      }

      // Position in bottom-right corner
      if (this.positionController) {
        this.positionController.setQuietPosition(true);
      }
      
      // Add quiet class for styling if needed
      const { spaceman } = this.elements;
      if (spaceman) spaceman.classList.add('quiet-mode');
    } else {
      // Reactivate
      const { spaceman } = this.elements;
      if (spaceman) spaceman.classList.remove('quiet-mode');
      
      // Resume normal positioning
      if (this.positionController) {
        this.positionController.setQuietPosition(false);
      }
      
      // Restart messaging and animations
      this._startIdleAnimations();
      this._startMessageCycle();
    }
  }

  // Public API
  setState(newState) {
    if (this.state === newState) return;

    this.state = newState;
    this.messageIndex = 0;
    // Do not reset _firstMessageShown — welcome should only show on first load, not on section change

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
    if (this.isQuiet) return; // Don't start message cycle when quiet
    if (this.isDetermined) return; // Freeze message cycle when determined
    
    const { states } = this._getThemeData();
    const stateData = states?.[this.state];
    const messages = this._getMergedMessages(this.state);

    const { message, fromMergedArray } = this._getNextMessage();
    if (!message) return;

    this._firstMessageShown = true;
    const speed = stateData?.typingSpeed || DEFAULTS.typingSpeed;
    const delay = stateData?.messageDelay || DEFAULTS.messageDelay;

    if (fromMergedArray && messages.length) {
      this._lastSpokenFromMergedArray = true;
      this._lastSpokenMergedIndex = this.messageIndex % messages.length;
    } else {
      this._lastSpokenFromMergedArray = false;
      this._lastSpokenMergedIndex = -1;
    }

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

    this._lastSpokenMessage = message;
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
    if (this.isQuiet) return; // Don't react when quiet
    
    const { reactions } = this._getThemeData();
    const reaction = reactions?.[type];
    if (!reaction) return;

    // Skip hover reaction when viewing content sections—contextual messages are more useful
    if (type === 'hover' && (this.state === 'playground' || this.state === 'portfolio')) return;

    this._clearTimer('typing');
    this._clearTimer('message');

    this._typeMessage(reaction, DEFAULTS.reactionSpeed);

    this._timers.message = setTimeout(() => {
      this._startMessageCycle();
    }, 2000);
  }

  // Idle animations (wave disabled for professional tone)
  _startIdleAnimations() {
    this._scheduleBlink();
  }

  _scheduleBlink() {
    if (this.isQuiet) return; // Don't schedule animations when quiet
    
    const { min, max } = DEFAULTS.blinkInterval;
    const delay = min + Math.random() * (max - min);

    this._timers.blink = setTimeout(() => {
      if (!this.isQuiet) {
        this._triggerBlink();
        this._scheduleBlink();
      }
    }, delay);
  }

  _scheduleWave() {
    if (this.isQuiet) return; // Don't schedule animations when quiet
    
    const { min, max } = DEFAULTS.waveInterval;
    const delay = min + Math.random() * (max - min);

    this._timers.wave = setTimeout(() => {
      if (!this.isQuiet && this.state === 'idle') this._triggerWave();
      if (!this.isQuiet) this._scheduleWave();
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
    if (this._clickTimeout) {
      clearTimeout(this._clickTimeout);
      this._clickTimeout = null;
    }
  }

  destroy() {
    this._clearAllTimers();
    this._hideHeroMenuUI();
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
