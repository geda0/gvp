// spaceman-position.js - Definitive positioning controller
// Keeps spaceman anchored near the dialog’s TOP-RIGHT, clamps fully on-screen,
// and prevents the *bubble* from ever going under the top nav.

class SpacemanPosition {
  constructor(spacemanElement, options = {}) {
    this.spaceman = spacemanElement;
    this.container =
      spacemanElement.closest('#spacemanContainer') || spacemanElement.parentElement;
    this.movable = this.container;

    this.options = {
      minScale: 0.5,
      maxScale: 1,
      padding: 125,          // legacy spacing “feel”
      transitionSpeed: 0.5,
      ...options
    };

    this.currentPosition = { x: 0, y: 0 };
    this.currentScale = 1;

    this._cleanupTimer = null;
    this._onEnd = null;
    this._updateT = null;

    this._settleKey = null;
    this._settleT1 = null;
    this._settleT2 = null;
    this._settleT3 = null;

    this._contentRO = null;
    this._spacemanRO = null;
    this._mutationObserver = null;

    this._onContentTransitionEnd = null;
    this._projects = null;
    this._portfolio = null;
    this._playgroundWrap = null;
    this._portfolioWrap = null;

    this.init();
  }

  init() {
    // CSS handles transition; we just update vars
    this.movable.style.willChange = 'transform';

    this.observeResize();
    this.observeContent();

    // Bubble typing + fonts can change spaceman size → reposition
    this._spacemanRO = new ResizeObserver(() => this.updatePosition());
    this._spacemanRO.observe(this.container);

    // Initial position
    this.updatePosition();

    // Post-layout settle (first paint)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.updatePosition());
    });

    // After all assets load
    window.addEventListener('load', () => this.updatePosition(), { once: true });

    // After fonts load (text reflow changes dialog layout)
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.updatePosition());
    }
  }

  observeResize() {
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.updatePosition(), 100);
    });
  }

  observeContent() {
    // Cache elements
    this._playgroundWrap = document.getElementById('playgroundContent');
    this._portfolioWrap = document.getElementById('portfolioContent');
    this._projects = document.getElementById('projects');
    this._portfolio = document.getElementById('portfolioProjects');

    // Class changes (open/close) -> reposition
    this._mutationObserver = new MutationObserver(() => {
      this.updatePosition();
    });

    [this._playgroundWrap, this._portfolioWrap].forEach(el => {
      if (!el) return;
      this._mutationObserver.observe(el, {
        attributes: true,
        attributeFilter: ['class']
      });
    });

    // Transition end (content anim finishes) -> final reposition
    this._onContentTransitionEnd = (e) => {
      if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
      this.updatePosition();
    };

    [this._playgroundWrap, this._portfolioWrap, this._projects, this._portfolio].forEach(el => {
      if (!el) return;
      el.addEventListener('transitionend', this._onContentTransitionEnd);
    });

    // Size changes (images, dynamic content) -> reposition
    this._contentRO = new ResizeObserver(() => this.updatePosition());
    [this._playgroundWrap, this._portfolioWrap, this._projects, this._portfolio].forEach(el => {
      if (el) this._contentRO.observe(el);
    });
  }

  updatePosition() {
    clearTimeout(this._updateT);
    this._updateT = setTimeout(() => this._updatePositionNow(), 80);
  }

  _updatePositionNow() {
    const viewport = this.getViewport();
    const visible = this.getVisibleContent();
    const content = visible ? visible.rect : null;

    // Toggle z-index class
    document.body.classList.toggle('content-open', !!content);

    let targetX = 0;
    let targetY = 0;
    let targetScale = 1;

    if (content) {
      // Schedule a single settle pass per “open”
      if (visible && visible.wrapper) {
        const key = visible.wrapper.id || 'content';
        if (this._settleKey !== key) {
          this._settleKey = key;
          this.scheduleFinalReposition(visible.wrapper);
          this.settleReposition();
        }
      } else {
        this._settleKey = null;
      }

      const spacemanSize = this.getSpacemanSize(); // astronaut-ish size
      const pos = this.calculateAvoidancePosition(viewport, content, spacemanSize);
      targetX = pos.x;
      targetY = pos.y;
      targetScale = pos.scale;
    } else {
      this._settleKey = null;
      // Home state
      targetX = 0;
      targetY = 0;
      if (viewport.isMobile) targetScale = viewport.width < 480 ? 0.55 : 0.7;
      else if (viewport.isTablet) targetScale = 0.85;
      else targetScale = 1;
    }

    this.moveTo(targetX, targetY, targetScale);
  }

  getViewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      isMobile: window.innerWidth < 768,
      isTablet: window.innerWidth >= 768 && window.innerWidth < 1024
    };
  }

  getVisibleContent() {
    const playgroundWrap = document.getElementById('playgroundContent');
    const portfolioWrap = document.getElementById('portfolioContent');

    const isActuallyVisible = (el) => {
      if (!el) return false;
      if (el.classList.contains('hidden')) return false;
      if (el.classList.contains('section-invisible')) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const isVisible = (el) =>
      el && (el.classList.contains('visible') || isActuallyVisible(el));

    if (isVisible(playgroundWrap)) {
      const section = document.getElementById('projects') || playgroundWrap;
      const rect = section.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { rect, wrapper: playgroundWrap };
    }

    if (isVisible(portfolioWrap)) {
      const section = document.getElementById('portfolioProjects') || portfolioWrap;
      const rect = section.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { rect, wrapper: portfolioWrap };
    }

    return null;
  }

  getSpacemanSize() {
    // Use body for anchoring “top-right” feel (astronaut), not bubble tail
    const body = this.spaceman?.querySelector('.spaceman-body');
    const rect = (body || this.spaceman || this.container).getBoundingClientRect();
    return {
      width: rect.width || 200,
      height: rect.height || 320
    };
  }

  // Schedule a final reposition after layout/transition settles for `el`.
  scheduleFinalReposition(el) {
    if (!el) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.updatePosition());
    });

    const handler = (e) => {
      if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
      this.updatePosition();
      el.removeEventListener('transitionend', handler);
    };

    el.addEventListener('transitionend', handler);
  }

  // Catch late layout shifts (images, fonts, transitions)
  settleReposition() {
    clearTimeout(this._settleT1);
    clearTimeout(this._settleT2);
    clearTimeout(this._settleT3);

    this.updatePosition();
    this._settleT1 = setTimeout(() => this.updatePosition(), 80);
    this._settleT2 = setTimeout(() => this.updatePosition(), 180);
    this._settleT3 = setTimeout(() => this.updatePosition(), 320);
  }

  calculateAvoidancePosition(viewport, content, spacemanSize) {
    const padding = this.options.padding;
    let x = 0;
    let y = 0;
    let scale = 1;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    // Nav safe zone
    const navOffset = 60;         // your header height estimate
    const NAV_SAFE_MARGIN = 16;   // extra breathing room so bubble never touches nav

    // Spacing:
    // - dialogPad: how far from dialog corner we *prefer*
    // - edgePad: how far from viewport edges we *must* stay (anti-clipping)
    const dialogPad = Math.min(40, padding);
    const edgePad = 20;

    // Choose base scale per viewport
    if (viewport.isMobile) scale = this.options.minScale;
    else if (viewport.isTablet) scale = 0.75;
    else scale = 1;

    // "Anchor sizing" (astronaut-ish) for placing near top-right
    const anchorScaled = {
      width: spacemanSize.width * scale,
      height: spacemanSize.height * scale
    };

    // "Visual sizing" (bubble included) for clamping so bubble never goes under nav
    // container.getBoundingClientRect is scaled by current transform; unscale back to base
    const fullRect = this.container.getBoundingClientRect();
    const unscale = this.currentScale || 1;

    const visualBase = {
      width: (fullRect.width / unscale) || spacemanSize.width,
      height: (fullRect.height / unscale) || spacemanSize.height
    };

    const visualScaled = {
      width: visualBase.width * scale,
      height: visualBase.height * scale
    };

    const clampToViewport = (cx, cy) => {
      const minX = -(viewport.width / 2) + (visualScaled.width / 2) + edgePad;
      const maxX =  (viewport.width / 2) - (visualScaled.width / 2) - edgePad;

      const minY =
        -(viewport.height / 2) +
        (visualScaled.height / 2) +
        edgePad +
        navOffset +
        NAV_SAFE_MARGIN;

      const maxY = (viewport.height / 2) - (visualScaled.height / 2) - edgePad;

      return {
        x: clamp(cx, minX, maxX),
        y: clamp(cy, minY, maxY)
      };
    };

    const spaceRight = viewport.width - content.right;
    const spaceLeft = content.left;

    // TOP-RIGHT anchor target (use safeTop for scroll)
    const safeTop = Math.max(content.top, 0);

    const targetCenterX =
      (content.right + dialogPad + (anchorScaled.width / 2)) - (viewport.width / 2);

    const targetCenterY =
      (safeTop + dialogPad + (anchorScaled.height / 2)) - (viewport.height / 2);

    // If left has clearly more room, go left-center (still clamp for nav)
    if (spaceLeft > anchorScaled.width + dialogPad && spaceLeft > spaceRight) {
      const leftX =
        (content.left - dialogPad - (anchorScaled.width / 2)) - (viewport.width / 2);
      const leftY = 0;

      ({ x, y } = clampToViewport(leftX, leftY));
      return { x, y, scale };
    }

    // Default: top-right anchor, but clamp using full visual size (bubble-safe)
    ({ x, y } = clampToViewport(targetCenterX, targetCenterY));
    return { x, y, scale };
  }

  moveTo(x, y, scale) {
    if (this._cleanupTimer) clearTimeout(this._cleanupTimer);

    this.movable.classList.add('moving', 'thrust');

    // Disable wobble when content is open (prevents “jitter” near dialog)
    const allowWobble = !document.body.classList.contains('content-open');
    const wobbleX = allowWobble ? (Math.random() - 0.5) * 5 : 0;
    const wobbleY = allowWobble ? (Math.random() - 0.5) * 5 : 0;

    // Force reflow to ensure transition is applied
    void this.movable.offsetWidth;

    this.movable.style.setProperty('--sx', `${x + wobbleX}px`);
    this.movable.style.setProperty('--sy', `${y + wobbleY}px`);
    this.movable.style.setProperty('--ss', `${scale}`);

    this.currentPosition = { x, y };
    this.currentScale = scale;

    const onEnd = (e) => {
      if (e.propertyName !== 'transform') return;
      this.movable.classList.remove('thrust', 'moving');
      this.movable.removeEventListener('transitionend', onEnd);
    };

    if (this._onEnd) {
      this.movable.removeEventListener('transitionend', this._onEnd);
    }
    this._onEnd = onEnd;
    this.movable.addEventListener('transitionend', onEnd);

    this._cleanupTimer = setTimeout(() => {
      this.movable.classList.remove('thrust', 'moving');
      this.movable.removeEventListener('transitionend', onEnd);
    }, (this.options.transitionSpeed * 1000) + 50);
  }

  setPosition(x, y, scale = 1) {
    this.moveTo(x, y, scale);
  }

  destroy() {
    clearTimeout(this._cleanupTimer);
    clearTimeout(this._updateT);
    clearTimeout(this._settleT1);
    clearTimeout(this._settleT2);
    clearTimeout(this._settleT3);

    if (this._onEnd) {
      this.movable.removeEventListener('transitionend', this._onEnd);
    }

    if (this._spacemanRO) this._spacemanRO.disconnect();

    if (this._onContentTransitionEnd) {
      [this._playgroundWrap, this._portfolioWrap, this._projects, this._portfolio].forEach(el => {
        if (el) el.removeEventListener('transitionend', this._onContentTransitionEnd);
      });
    }

    if (this._contentRO) this._contentRO.disconnect();
    if (this._mutationObserver) this._mutationObserver.disconnect();
  }
}

export function initSpacemanPosition(spacemanElement, options) {
  return new SpacemanPosition(spacemanElement, options);
}

export { SpacemanPosition };