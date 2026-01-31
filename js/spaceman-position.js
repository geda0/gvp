// spaceman-position.js - Simplified positioning controller
// Anchors spaceman near dialog TOP-RIGHT, clamps to viewport, respects nav

class SpacemanPosition {
  constructor(spacemanElement, options = {}) {
    this.spaceman = spacemanElement;
    this.container =
      spacemanElement.closest('#spacemanContainer') || spacemanElement.parentElement;
    this.movable = this.container;

    this.options = {
      minScale: 0.5,
      padding: 40,
      navHeight: 60,
      edgePad: 20,
      transitionSpeed: 0.5,
      ...options
    };

    this.currentScale = 1;
    this._updateT = null;
    this._cleanupTimer = null;
    this._onEnd = null;

    this.init();
  }

  init() {
    this._bindObservers();

    // Initial + post-paint
    this.updatePosition();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.updatePosition());
    });

    // After assets/fonts
    window.addEventListener('load', () => this.updatePosition(), { once: true });
    document.fonts?.ready?.then(() => this.updatePosition());
  }

  _bindObservers() {
    const contentEls = [
      document.getElementById('playgroundContent'),
      document.getElementById('portfolioContent'),
      document.getElementById('projects'),
      document.getElementById('portfolioProjects')
    ].filter(Boolean);

    // Class changes -> reposition
    this._mutationObs = new MutationObserver(() => this.updatePosition());
    contentEls.slice(0, 2).forEach(el => {
      this._mutationObs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });

    // Size changes -> reposition
    this._resizeObs = new ResizeObserver(() => this.updatePosition());
    contentEls.forEach(el => this._resizeObs.observe(el));
    this._resizeObs.observe(this.container);

    // Transition end -> reposition
    this._onTransitionEnd = (e) => {
      if (e.propertyName === 'transform' || e.propertyName === 'opacity') {
        this.updatePosition();
      }
    };
    contentEls.forEach(el => el.addEventListener('transitionend', this._onTransitionEnd));
    this._contentEls = contentEls;

    // Window resize
    let resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => this.updatePosition(), 100);
    });
  }

  updatePosition() {
    clearTimeout(this._updateT);
    this._updateT = setTimeout(() => this._update(), 50);
  }

  _update() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 768;
    const isTablet = vw >= 768 && vw < 1024;

    const content = this._getVisibleContent();
    document.body.classList.toggle('content-open', !!content);

    let x = 0, y = 0, scale = 1;

    if (content) {
      // Content open: position near content
      scale = isMobile ? 0.6 : isTablet ? 0.75 : 1;
      const pos = this._calcPosition(vw, vh, content, scale, isMobile);
      x = pos.x;
      y = pos.y;
    } else {
      // Home: centered, slightly above on mobile
      scale = isMobile ? (vw < 480 ? 0.65 : 0.75) : isTablet ? 0.85 : 1;
      y = isMobile ? -30 : 0;
    }

    this._moveTo(x, y, scale);
  }

  _getVisibleContent() {
    const check = (wrapperId, sectionId) => {
      const wrapper = document.getElementById(wrapperId);
      if (!wrapper) return null;
      if (wrapper.classList.contains('hidden') || wrapper.classList.contains('section-invisible')) return null;
      if (!wrapper.classList.contains('visible')) {
        const r = wrapper.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
      }
      const section = document.getElementById(sectionId) || wrapper;
      const rect = section.getBoundingClientRect();
      return (rect.width > 0 && rect.height > 0) ? rect : null;
    };

    return check('playgroundContent', 'projects') || check('portfolioContent', 'portfolioProjects');
  }

  _calcPosition(vw, vh, content, scale, isMobile = false) {
    const { padding, navHeight, edgePad } = this.options;

    // Get full container size (includes bubble), unscale to base
    const rect = this.container.getBoundingClientRect();
    const baseW = (rect.width / (this.currentScale || 1)) || 200;
    const baseH = (rect.height / (this.currentScale || 1)) || 320;
    const w = baseW * scale;
    const h = baseH * scale;

    // Clamp bounds
    const minX = -vw/2 + w/2 + edgePad;
    const maxX = vw/2 - w/2 - edgePad;
    const minY = -vh/2 + h/2 + edgePad + navHeight;
    const maxY = vh/2 - h/2 - edgePad;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // Mobile: position at top center above content
    if (isMobile) {
      return { x: 0, y: clamp(minY, minY, maxY) };
    }

    // Desktop/tablet: position near content edge
    const safeTop = Math.max(content.top, 0);
    let x = (content.right + padding + w/2) - vw/2;
    let y = (safeTop + padding + h/2) - vh/2;

    // If more space on left, go left instead
    if (content.left > vw - content.right && content.left > w + padding) {
      x = (content.left - padding - w/2) - vw/2;
      y = 0;
    }

    return { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY) };
  }

  _moveTo(x, y, scale) {
    clearTimeout(this._cleanupTimer);
    this.movable.classList.add('moving', 'thrust');

    // No wobble when content open
    const wobble = document.body.classList.contains('content-open') ? 0 : (Math.random() - 0.5) * 5;

    this.movable.style.setProperty('--sx', `${x + wobble}px`);
    this.movable.style.setProperty('--sy', `${y + wobble}px`);
    this.movable.style.setProperty('--ss', `${scale}`);
    this.currentScale = scale;

    const cleanup = () => {
      this.movable.classList.remove('thrust', 'moving');
      this.movable.removeEventListener('transitionend', onEnd);
    };

    const onEnd = (e) => {
      if (e.propertyName === 'transform') cleanup();
    };

    if (this._onEnd) this.movable.removeEventListener('transitionend', this._onEnd);
    this._onEnd = onEnd;
    this.movable.addEventListener('transitionend', onEnd);

    this._cleanupTimer = setTimeout(cleanup, this.options.transitionSpeed * 1000 + 50);
  }

  destroy() {
    clearTimeout(this._updateT);
    clearTimeout(this._cleanupTimer);
    if (this._onEnd) this.movable.removeEventListener('transitionend', this._onEnd);
    this._mutationObs?.disconnect();
    this._resizeObs?.disconnect();
    this._contentEls?.forEach(el => el.removeEventListener('transitionend', this._onTransitionEnd));
  }
}

export function initSpacemanPosition(spacemanElement, options) {
  return new SpacemanPosition(spacemanElement, options);
}

export { SpacemanPosition };
