// spaceman-position.js - Definitive positioning controller

class SpacemanPosition {
  constructor(spacemanElement, options = {}) {
    
    this.spaceman = spacemanElement;
    this.container = spacemanElement.closest('#spacemanContainer') || spacemanElement.parentElement;
    this.movable = this.container;

    this.options = {
      minScale: 0.5,
      maxScale: 1,
      padding: 125,
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
    this._onContentTransitionEnd = null;
    this._projects = null;
    this._portfolio = null;

    this.init();
  }

  init() {
    // CSS handles transition - just set willChange for performance
    this.movable.style.willChange = 'transform';

    this.observeResize();
    this.observeContent();

    // Also watch spacemanContainer/spaceman for size changes (bubble typing, fonts)
    this._spacemanRO = new ResizeObserver(() => this.updatePosition());
    this._spacemanRO.observe(this.container); // #spacemanContainer

    // Initial position
    this.updatePosition();

    // Post-layout settle: wait for browser to finish first paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.updatePosition());
    });

    // After all assets (images) load
    window.addEventListener('load', () => this.updatePosition(), { once: true });

    // After fonts load (text reflow can change dialog width/height)
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
    // Class changes
    this._mutationObserver = new MutationObserver(() => {
      this.updatePosition();
    });

    // Named handler for cleanup / transition-triggered reposition
    this._onContentTransitionEnd = (e) => {
      if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
      this.updatePosition();
    };

    // Cache wrapper elements and observe class changes on them
    this._playgroundWrap = document.getElementById('playgroundContent');
    this._portfolioWrap = document.getElementById('portfolioContent');

    [this._playgroundWrap, this._portfolioWrap].forEach(el => {
      if (!el) return;

      this._mutationObserver.observe(el, {
        attributes: true,
        attributeFilter: ['class']
      });

      // Listen for transitions on wrappers (NOW handler is defined)
      el.addEventListener('transitionend', this._onContentTransitionEnd);
    });

    // Size changes (images, content)
    this._contentRO = new ResizeObserver(() => this.updatePosition());

    this._projects = document.getElementById('projects');
    this._portfolio = document.getElementById('portfolioProjects');

    // Observe and attach transition listeners to inner sections
    if (this._projects) {
      this._contentRO.observe(this._projects);
      this._projects.addEventListener('transitionend', this._onContentTransitionEnd);
    }

    if (this._portfolio) {
      this._contentRO.observe(this._portfolio);
      this._portfolio.addEventListener('transitionend', this._onContentTransitionEnd);
    }

    // Also observe wrappers for size changes
    if (this._playgroundWrap) this._contentRO.observe(this._playgroundWrap);
    if (this._portfolioWrap) this._contentRO.observe(this._portfolioWrap);
  }

  updatePosition() {
    clearTimeout(this._updateT);
    this._updateT = setTimeout(() => this._updatePositionNow(), 80);
  }

  _updatePositionNow() {
    const viewport = this.getViewport();
    const visible = this.getVisibleContent();
    const content = visible ? visible.rect : null;
    const spacemanSize = this.getSpacemanSize();

    // Toggle z-index class
    document.body.classList.toggle('content-open', !!content);

    let targetX = 0;
    let targetY = 0;
    let targetScale = 1;

    if (content) {
      // Schedule a single final reposition per-open (avoid repeated scheduling)
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

      const position = this.calculateAvoidancePosition(viewport, content, spacemanSize);
      targetX = position.x;
      targetY = position.y;
      targetScale = position.scale;
    } else {
      this._settleKey = null;
      // Home state
      targetX = 0;
      targetY = 0;
      if (viewport.isMobile) {
        targetScale = viewport.width < 480 ? 0.55 : 0.7;
      } else if (viewport.isTablet) {
        targetScale = 0.85;
      } else {
        targetScale = 1;
      }
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

    // Better visibility check using rect dimensions
    const isActuallyVisible = (el) => {
      if (!el) return false;
      if (el.classList.contains('hidden')) return false;
      if (el.classList.contains('section-invisible')) return false;
      // Check if element has actual dimensions (not display:none or collapsed)
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    // Also support explicit 'visible' class
    const isVisible = (el) =>
      el && (el.classList.contains('visible') || isActuallyVisible(el));

    if (isVisible(playgroundWrap)) {
      const section = document.getElementById('projects') || playgroundWrap;
      const rect = section.getBoundingClientRect();
      // Verify section also has dimensions
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
    // Measure only the body so "top-right" means astronaut, not bubble+tail
    const body = this.spaceman?.querySelector('.spaceman-body');
    const rect = (body || this.container).getBoundingClientRect();
    return {
      width: rect.width || 200,
      height: rect.height || 320
    };
  }

  // Schedule a final reposition after layout/transition settles for `el`.
  scheduleFinalReposition(el) {
    if (!el) return;

    // double rAF to wait for layout & paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.updatePosition());
    });

    // Add a one-time transitionend listener that filters to transform/opacity
    const handler = (e) => {
      if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
      this.updatePosition();
      el.removeEventListener('transitionend', handler);
    };

    el.addEventListener('transitionend', handler);
  }

  // Run several delayed updates to catch late layout shifts (images, fonts, transitions)
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
    const padding = this.options.padding; // your existing option (currently 125)
    let x = 0;
    let y = 0;
    let scale = 1;

    const getScaledSize = (s) => ({
      width: spacemanSize.width * s,
      height: spacemanSize.height * s
    });

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    // Header height / nav area offset
    const navOffset = 60;

    // IMPORTANT: separate padding types
    // - dialogPad: how far from the dialog corner we want to sit
    // - edgePad: how far from the viewport edge we must stay to avoid clipping
    const dialogPad = Math.min(40, padding); // cap dialog spacing
    const edgePad = 20;                     // small safe edge inset

    // Helper: clamp X/Y so the *center* of the spaceman cluster stays on-screen
    const clampToViewport = (cx, cy, scaled) => {
      const minX = -(viewport.width / 2) + (scaled.width / 2) + edgePad;
      const maxX =  (viewport.width / 2) - (scaled.width / 2) - edgePad;

      const minY = -(viewport.height / 2) + (scaled.height / 2) + edgePad + navOffset;
      const maxY =  (viewport.height / 2) - (scaled.height / 2) - edgePad;

      return {
        x: clamp(cx, minX, maxX),
        y: clamp(cy, minY, maxY)
      };
    };

    // Choose base scale per viewport
    if (viewport.isMobile) {
      scale = this.options.minScale;
    } else if (viewport.isTablet) {
      scale = 0.75;
    } else {
      scale = 1;
    }

    const scaled = getScaledSize(scale);
    const spaceRight = viewport.width - content.right;
    const spaceLeft = content.left;

    // Primary: anchor to TOP-RIGHT of dialog (use safeTop for scroll)
    const safeTop = Math.max(content.top, 0);

    const targetCenterX =
      (content.right + dialogPad + (scaled.width / 2)) - (viewport.width / 2);

    // after (FIX)
    const targetCenterY =
      (safeTop + dialogPad + (scaled.height / 2)) - (viewport.height / 2);
      
    // If there's clearly more room on the left, prefer left-side placement
    if (spaceLeft > scaled.width + dialogPad && spaceLeft > spaceRight) {
      x = (content.left - dialogPad - (scaled.width / 2)) - (viewport.width / 2);
      y = 0;
      ({ x, y } = clampToViewport(x, y, scaled));
      return { x, y, scale };
    }

    // Otherwise clamp top-right anchor so it never clips offscreen
    ({ x, y } = clampToViewport(targetCenterX, targetCenterY, scaled));

    return { x, y, scale };
  }

  moveTo(x, y, scale) {
    if (this._cleanupTimer) clearTimeout(this._cleanupTimer);

    this.movable.classList.add('moving', 'thrust');

    const allowWobble = !document.body.classList.contains('content-open');
    const wobbleX = allowWobble ? (Math.random() - 0.5) * 5 : 0;
    const wobbleY = allowWobble ? (Math.random() - 0.5) * 5 : 0;

    void this.movable.offsetWidth;

    // PIXELS ONLY - CSS handles centering via translate(-50%, -50%)
    // Use CSS variables so centering is preserved by CSS
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

    // Remove content transition listeners
    if (this._onContentTransitionEnd) {
      if (this._projects) this._projects.removeEventListener('transitionend', this._onContentTransitionEnd);
      if (this._portfolio) this._portfolio.removeEventListener('transitionend', this._onContentTransitionEnd);
      if (this._playgroundWrap) this._playgroundWrap.removeEventListener('transitionend', this._onContentTransitionEnd);
      if (this._portfolioWrap) this._portfolioWrap.removeEventListener('transitionend', this._onContentTransitionEnd);
    }

    if (this._contentRO) {
      this._contentRO.disconnect();
    }

    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
    }
  }
}

export function initSpacemanPosition(spacemanElement, options) {
  return new SpacemanPosition(spacemanElement, options);
}

export { SpacemanPosition };
