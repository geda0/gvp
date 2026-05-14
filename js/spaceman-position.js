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
      postDragLayoutCooldownMs: 3500,
      ...options
    };

    this.currentScale = 1;
    this._updateT = null;
    this._cleanupTimer = null;
    this._onEnd = null;
    this.isQuiet = false;
    this.isStaying = false;
    this._isDragging = false;
    this._dragReturnTimer = null;
    this._layoutCooldownUntil = 0;
    this._hooks = {};

    this.init();
  }

  setHooks(hooks = {}) {
    this._hooks = { ...this._hooks, ...hooks };
  }

  /** Keep `body.content-open` in sync with visible playground/portfolio (hero CSS) even when `isStaying` skips layout `_update`. */
  _syncBodyContentOpen() {
    const pg = document.getElementById('playgroundContent');
    const pf = document.getElementById('portfolioContent');
    const wrapperOpen =
      !!(pg &&
        pg.classList.contains('visible') &&
        !pg.classList.contains('hidden')) ||
      !!(pf &&
        pf.classList.contains('visible') &&
        !pf.classList.contains('hidden'));
    // Navigation owns clearing `content-open` on Home. Only assert true here so we never
    // transiently remove it during layout passes (which used to re-center `#load`).
    if (wrapperOpen) document.body.classList.add('content-open');
  }

  init() {
    this._bindObservers();
    this._bindDrag();

    // Initial + post-paint
    this.updatePosition();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.updatePosition());
    });

    // After assets/fonts
    window.addEventListener('load', () => this.updatePosition(), { once: true });
    document.fonts?.ready?.then(() => this.updatePosition());
  }

  _getProjectDialogPanelRect() {
    if (!document.body.classList.contains('project-dialog-open')) return null;
    const dialog = document.getElementById('projectDialog');
    if (!dialog || dialog.hidden) return null;
    const panel = dialog.querySelector('.project-dialog__panel');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return rect;
  }

  _bindObservers() {
    const projectDialog = document.getElementById('projectDialog');
    const dialogPanel = projectDialog?.querySelector('.project-dialog__panel');
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
    if (projectDialog) {
      this._mutationObs.observe(projectDialog, { attributes: true, attributeFilter: ['hidden'] });
    }

    // Size changes -> reposition
    this._resizeObs = new ResizeObserver(() => this.updatePosition());
    contentEls.forEach(el => this._resizeObs.observe(el));
    if (dialogPanel) this._resizeObs.observe(dialogPanel);
    this._resizeObs.observe(this.container);
    const heroCopy = document.querySelector('.hero-copy')
    if (heroCopy) this._resizeObs.observe(heroCopy)

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

  _isLayoutCooldownActive() {
    return Date.now() < this._layoutCooldownUntil;
  }

  _clearPostDragCooldown() {
    this._layoutCooldownUntil = 0;
    clearTimeout(this._dragReturnTimer);
    this._dragReturnTimer = null;
  }

  updatePosition() {
    this._syncBodyContentOpen();
    if (this._isDragging) return;
    if (this._isLayoutCooldownActive()) return;
    if (this.isStaying) {
      clearTimeout(this._updateT);
      this._updateT = setTimeout(() => this._clampStayingIfNeeded(), 50);
      return;
    }
    clearTimeout(this._updateT);
    this._updateT = setTimeout(() => this._update(), 50);
  }

  _bindDrag() {
    const el = this.spaceman;
    if (!el) return;

    let startX, startY, startSX, startSY;
    let dragMoved = false;
    const THRESHOLD = 5;

    const onPointerDown = (e) => {
      /* Touch/pen use primary contact; only filter non-primary mouse buttons */
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      startSX = parseFloat(this.movable.style.getPropertyValue('--sx')) || 0;
      startSY = parseFloat(this.movable.style.getPropertyValue('--sy')) || 0;
      dragMoved = false;

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!this._isDragging && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        const wasStaying = this.isStaying;
        if (wasStaying) this.isStaying = false;
        this._isDragging = true;
        dragMoved = true;
        this.movable.classList.add('dragging');
        el.classList.add('dragging-active');
        clearTimeout(this._dragReturnTimer);
        this._hooks.onDragStart?.({ wasStaying });
      }

      if (this._isDragging) {
        this.movable.style.setProperty('--sx', `${startSX + dx}px`);
        this.movable.style.setProperty('--sy', `${startSY + dy}px`);
      }
    };

    const onPointerUp = (e) => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      if (e?.pointerId != null) {
        try {
          if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        } catch (_) { /* noop */ }
      }

      if (this._isDragging) {
        this._isDragging = false;
        this.movable.classList.remove('dragging');
        el.classList.remove('dragging-active');
        clearTimeout(this._dragReturnTimer);
        this._dragReturnTimer = null;

        if (dragMoved && this._hooks.onDragEnd) {
          this._hooks.onDragEnd(true);
        }

        if (dragMoved) {
          const cd = this.options.postDragLayoutCooldownMs;
          this._layoutCooldownUntil = Date.now() + cd;
          this._dragReturnTimer = setTimeout(() => {
            this._layoutCooldownUntil = 0;
            this._dragReturnTimer = null;
            if (!this._hooks.onDragEnd) {
              this._update();
            } else {
              this.updatePosition();
            }
          }, cd);
        }
      }
    };

    el.addEventListener('pointerdown', onPointerDown);

    el.addEventListener('click', (e) => {
      if (dragMoved) {
        e.stopImmediatePropagation();
        e.preventDefault();
        dragMoved = false;
      }
    }, true);

    this._dragCleanup = () => {
      el.removeEventListener('pointerdown', onPointerDown);
      this._clearPostDragCooldown();
    };
  }

  _clampStayingIfNeeded() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale =
      parseFloat(this.movable.style.getPropertyValue('--ss')) || this.currentScale || 0.75;
    const sx = parseFloat(this.movable.style.getPropertyValue('--sx')) || 0;
    const sy = parseFloat(this.movable.style.getPropertyValue('--sy')) || 0;
    const b = this._getBounds(vw, vh, scale);
    const nx = Math.max(b.minX, Math.min(b.maxX, sx));
    const ny = Math.max(b.minY, Math.min(b.maxY, sy));
    if (nx !== sx || ny !== sy) {
      this.movable.style.setProperty('--sx', `${nx}px`);
      this.movable.style.setProperty('--sy', `${ny}px`);
    }
  }

  setStaying(stay) {
    this._clearPostDragCooldown();
    this.isStaying = !!stay;
    if (!this.isStaying) {
      this.updatePosition();
    } else {
      this._syncBodyContentOpen();
      this._clampStayingIfNeeded();
    }
  }

  /** After a drag, user dismissed the stay prompt without pinning — return to auto layout. */
  declineStayAfterDrag() {
    if (this.isStaying) return;
    this._clearPostDragCooldown();
    this._update();
  }

  _update() {
    this._syncBodyContentOpen();
    if (this.isStaying) {
      this._clampStayingIfNeeded();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 768;
    const isTablet = vw >= 768 && vw < 1024;

    let x = 0, y = 0, scale = 1;

    if (this.isQuiet) {
      // Quiet mode: position in bottom-right corner
      scale = isMobile ? 0.35 : isTablet ? 0.45 : 0.5;
      const bounds = this._getBounds(vw, vh, scale);
      const edgePad = vw < 768 ? 12 : this.options.edgePad;
      x = bounds.maxX - edgePad;
      y = bounds.maxY - edgePad;
    } else {
      const dialogContent = this._getProjectDialogPanelRect();
      const content = dialogContent || this._getVisibleContent();

      if (content) {
        const dialogOpen = !!dialogContent;
        scale = dialogOpen
          ? (isMobile ? 0.4 : isTablet ? 0.5 : 0.62)
          : isMobile ? 0.45 : isTablet ? 0.55 : 0.7;
        const pos = this._calcPosition(vw, vh, content, scale);
        x = pos.x;
        y = pos.y;
      } else {
        scale = isMobile ? (vw < 480 ? 0.5 : 0.55) : isTablet ? 0.65 : 0.75;
        const bounds = this._getBounds(vw, vh, scale);
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
        const heroCopy = document.querySelector('.hero-copy')
        const rect = this.container.getBoundingClientRect()
        const baseW = (rect.width / (this.currentScale || 1)) || 200
        const baseH = (rect.height / (this.currentScale || 1)) || 320
        const w = baseW * scale
        const h = baseH * scale
        const pad = this.options.padding

        if (heroCopy) {
          const r = heroCopy.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            const edgePad = vw < 768 ? 12 : this.options.edgePad
            const fitsLeft = r.left - pad - w >= edgePad
            if (fitsLeft) {
              const cx = r.left - pad - w / 2
              const cy = r.top + r.height / 2
              x = clamp(cx - vw / 2, bounds.minX, bounds.maxX)
              y = clamp(cy - vh / 2, bounds.minY, bounds.maxY)
            } else {
              /* No room beside copy: hug top-left of safe area (nav + edge pad) */
              x = bounds.minX
              y = bounds.minY
            }
          } else {
            x = clamp(0, bounds.minX, bounds.maxX)
            y = clamp(isMobile ? -30 : 0, bounds.minY, bounds.maxY)
          }
        } else {
          const desiredX = isMobile ? 32 : 0
          const desiredY = isMobile ? -30 : 0
          x = clamp(desiredX, bounds.minX, bounds.maxX)
          y = clamp(desiredY, bounds.minY, bounds.maxY)
        }
      }
    }

    this._moveTo(x, y, scale);
  }

  setQuietPosition(quiet) {
    this.isQuiet = quiet;
    this._clearPostDragCooldown();
    this.updatePosition();
  }

  _getDockClearance() {
    const dock = document.getElementById('heroChatDock')
    if (!dock || dock.hidden) return 0
    const rect = dock.getBoundingClientRect()
    if (rect.height <= 0 || rect.width <= 0) return 0
    return rect.height + 8
  }

  _getBounds(vw, vh, scale) {
    const { navHeight } = this.options;
    const dockClearance = this._getDockClearance()
    const edgePad = vw < 768 ? 12 : this.options.edgePad;
    const rect = this.container.getBoundingClientRect();
    const baseW = (rect.width / (this.currentScale || 1)) || 200;
    const baseH = (rect.height / (this.currentScale || 1)) || 320;
    const w = baseW * scale;
    const h = baseH * scale;
    return {
      minX: -vw / 2 + w / 2 + edgePad,
      maxX: vw / 2 - w / 2 - edgePad,
      minY: -vh / 2 + h / 2 + edgePad + navHeight + dockClearance,
      maxY: vh / 2 - h / 2 - edgePad
    };
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

  _calcPosition(vw, vh, content, scale) {
    const { padding } = this.options;
    const bounds = this._getBounds(vw, vh, scale);
    const { minX, maxX, minY, maxY } = bounds;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const rect = this.container.getBoundingClientRect();
    const baseW = (rect.width / (this.currentScale || 1)) || 200;
    const baseH = (rect.height / (this.currentScale || 1)) || 320;
    const w = baseW * scale;
    const h = baseH * scale;

    const edgePad = vw < 768 ? 12 : this.options.edgePad;
    const safeTop = Math.max(content.top, 0);
    const fitsLeft = content.left - padding - w >= edgePad;

    let x;
    let y;

    if (fitsLeft) {
      // Same as home: left of the content column when there is room (including mobile)
      x = (content.left - padding - w / 2) - vw / 2;
      y = (safeTop + padding + h / 2) - vh / 2;
    } else {
      // No room beside column: hug top-left of safe viewport
      x = minX;
      y = minY;
    }

    return { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY) };
  }

  _moveTo(x, y, scale) {
    clearTimeout(this._cleanupTimer);
    this.movable.classList.add('moving', 'thrust');

    // No wobble when content open
    const wobble =
      document.body.classList.contains('content-open') ||
      document.body.classList.contains('project-dialog-open')
        ? 0
        : (Math.random() - 0.5) * 5;

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
    this._clearPostDragCooldown();
    if (this._onEnd) this.movable.removeEventListener('transitionend', this._onEnd);
    this._mutationObs?.disconnect();
    this._resizeObs?.disconnect();
    this._contentEls?.forEach(el => el.removeEventListener('transitionend', this._onTransitionEnd));
    this._dragCleanup?.();
  }
}

export function initSpacemanPosition(spacemanElement, options) {
  return new SpacemanPosition(spacemanElement, options);
}

export { SpacemanPosition };
