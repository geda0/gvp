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
      /* Fixed site header is taller than old in-flow nav; keep bubble clear of bar */
      navHeight: 72,
      edgePad: 20,
      transitionSpeed: 0.5,
      postDragLayoutCooldownMs: 3500,
      ...options
    };

    this.currentScale = 1;
    this._updateT = null;
    this._cleanupTimer = null;
    this._onEnd = null;
    this._resizeTimer = null;
    this._scrollTimer = null;
    this._onResize = null;
    this._onScrollLike = null;
    this._visualViewport = null;
    this.isQuiet = false;
    this.isStaying = false;
    this._isDragging = false;
    this._dragReturnTimer = null;
    this._layoutCooldownUntil = 0;
    this._hooks = {};
    this.agentTrail = document.getElementById('agentTrail')
    this.agentNode = document.getElementById('agentNode')
    this._trailVisible = true
    this._trailLoopRaf = null

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
    this._updateTrail()
  }

  _readDialogPanelRect(dialogId, panelSelector) {
    const dialog = document.getElementById(dialogId);
    if (!dialog || dialog.hidden) return null;
    const panel = dialog.querySelector(panelSelector);
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return rect;
  }

  _getActiveDialogPanelRect() {
    const checks = [
      {
        bodyClass: 'project-dialog-open',
        dialogId: 'projectDialog',
        panelSelector: '.project-dialog__panel'
      },
      {
        bodyClass: 'chat-dialog-open',
        dialogId: 'chatDialog',
        panelSelector: '.chat-dialog__panel'
      },
      {
        bodyClass: 'contact-dialog-open',
        dialogId: 'contactDialog',
        panelSelector: '.contact-dialog__panel'
      }
    ];

    for (const check of checks) {
      if (!document.body.classList.contains(check.bodyClass)) continue;
      const rect = this._readDialogPanelRect(check.dialogId, check.panelSelector);
      if (rect) return rect;
    }
    return null;
  }

  _bindObservers() {
    const dialogs = [
      { id: 'projectDialog', panelSelector: '.project-dialog__panel' },
      { id: 'chatDialog', panelSelector: '.chat-dialog__panel' },
      { id: 'contactDialog', panelSelector: '.contact-dialog__panel' }
    ];
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
    dialogs
      .map(({ id }) => document.getElementById(id))
      .filter(Boolean)
      .forEach((dialog) => {
        this._mutationObs.observe(dialog, { attributes: true, attributeFilter: ['hidden'] });
      });

    // Size changes -> reposition
    this._resizeObs = new ResizeObserver(() => this.updatePosition());
    contentEls.forEach(el => this._resizeObs.observe(el));
    dialogs.forEach(({ id, panelSelector }) => {
      const panel = document.getElementById(id)?.querySelector(panelSelector);
      if (panel) this._resizeObs.observe(panel);
    });
    this._resizeObs.observe(this.container);
    if (this.agentNode) this._resizeObs.observe(this.agentNode)
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

    this._onResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.updatePosition(), 100);
    };
    window.addEventListener('resize', this._onResize);

    this._onScrollLike = () => {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(() => this.updatePosition(), 45);
    };
    window.addEventListener('scroll', this._onScrollLike, { passive: true });

    this._visualViewport = window.visualViewport || null;
    if (this._visualViewport) {
      this._visualViewport.addEventListener('scroll', this._onScrollLike);
      this._visualViewport.addEventListener('resize', this._onScrollLike);
    }

    if (this.agentNode) {
      this._agentNodeMutationObs = new MutationObserver(() => this._updateTrail())
      this._agentNodeMutationObs.observe(this.agentNode, {
        attributes: true,
        attributeFilter: ['class', 'data-state', 'data-slot']
      })
    }
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
    this._updateTrail()
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
      const dialogContent = this._getActiveDialogPanelRect();
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
        /* Home hero: slightly smaller than legacy full-page scale, closer to docked agent */
        scale = isMobile ? (vw < 480 ? 0.4 : 0.46) : isTablet ? 0.5 : 0.54;
        const bounds = this._getBounds(vw, vh, scale);
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
        const heroCopy = document.querySelector('.hero-copy')
        const heroSlot = document.getElementById('agentSlotHero')
        const dockedAgent = document.getElementById('agentNode')
        const slotRect = (heroSlot && dockedAgent?.parentElement === heroSlot)
          ? heroSlot.getBoundingClientRect()
          : null
        const rect = this.container.getBoundingClientRect()
        const baseW = (rect.width / (this.currentScale || 1)) || 200
        const baseH = (rect.height / (this.currentScale || 1)) || 320
        const w = baseW * scale
        const h = baseH * scale
        const pad = this.options.padding
        const heroPad = Math.min(pad, vw < 768 ? 26 : 22)

        let placedHome = false
        const navGlue = vw < 768 ? 8 : 6
        if (dockedAgent?.dataset?.slot === 'navbar') {
          const nr = dockedAgent.getBoundingClientRect()
          const g = this._glueLeftOfAgentRect(vw, vh, scale, nr, navGlue)
          if (g) {
            x = g.x
            y = g.y
            placedHome = true
          }
        }

        if (
          !placedHome
          && slotRect
          && slotRect.width > 40
          && slotRect.height > 8
        ) {
          const nodeRect = dockedAgent?.getBoundingClientRect?.()
          const ref =
            nodeRect && nodeRect.width > 8 && nodeRect.height > 8 ? nodeRect : slotRect
          /* Tight horizontal glue: right edge of figure ≈ ref.left − heroGlueGap */
          const heroGlueGap = vw < 768 ? 7 : 5
          const g = this._glueLeftOfAgentRect(vw, vh, scale, ref, heroGlueGap)
          if (g) {
            x = g.x
            y = g.y
            placedHome = true
          }
        }
        if (!placedHome && heroCopy) {
          const r = heroCopy.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            const edgePad = vw < 768 ? 12 : this.options.edgePad
            const fitsLeft = r.left - heroPad - w >= edgePad
            if (fitsLeft) {
              const cx = r.left - heroPad - w / 2
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
        } else if (!placedHome) {
          const desiredX = isMobile ? 32 : 0
          const desiredY = isMobile ? -30 : 0
          x = clamp(desiredX, bounds.minX, bounds.maxX)
          y = clamp(desiredY, bounds.minY, bounds.maxY)
        }
      }
    }

    this._moveTo(x, y, scale);
    this._updateTrail()
  }

  setQuietPosition(quiet) {
    this.isQuiet = quiet;
    this._clearPostDragCooldown();
    this.updatePosition();
  }

  /**
   * Place spaceman so its right edge sits `glueGap` px left of `ref` (agent or slot rect).
   * Vertical center tracks ref midline; clamps to viewport bounds.
   */
  _glueLeftOfAgentRect(vw, vh, scale, ref, glueGap) {
    if (!ref || ref.width < 8 || ref.height < 8) return null
    const bounds = this._getBounds(vw, vh, scale)
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
    const rect = this.container.getBoundingClientRect()
    const baseW = (rect.width / (this.currentScale || 1)) || 200
    const baseH = (rect.height / (this.currentScale || 1)) || 320
    const w = baseW * scale
    const h = baseH * scale
    const cx = ref.left - glueGap - w / 2
    const cy = ref.top + ref.height / 2
    return {
      x: clamp(cx - vw / 2, bounds.minX, bounds.maxX),
      y: clamp(cy - vh / 2, bounds.minY, bounds.maxY)
    }
  }

  _getDockClearance() {
    const node = document.getElementById('agentNode')
    if (!node || node.dataset.slot !== 'hero') return 0
    const nRect = node.getBoundingClientRect()
    if (nRect.height > 8 && nRect.width > 0) return nRect.height + 10
    const heroSlot = document.getElementById('agentSlotHero')
    if (heroSlot) {
      const r = heroSlot.getBoundingClientRect()
      if (r.height > 0 && r.width > 0) return r.height + 8
    }
    const legacyDock = document.getElementById('heroChatDock')
    if (legacyDock && !legacyDock.hidden) {
      const r = legacyDock.getBoundingClientRect()
      if (r.height > 0 && r.width > 0) return r.height + 8
    }
    return 0
  }

  _getBounds(vw, vh, scale) {
    const { navHeight } = this.options;
    const dockClearance = this._getDockClearance()
    const edgePad = vw < 768 ? 12 : this.options.edgePad;
    const bubbleSafetyPad = vw < 768 ? 22 : 10;
    const rect = this.container.getBoundingClientRect();
    const baseW = (rect.width / (this.currentScale || 1)) || 200;
    const baseH = (rect.height / (this.currentScale || 1)) || 320;
    const w = baseW * scale;
    const h = baseH * scale;
    return {
      minX: -vw / 2 + w / 2 + edgePad + bubbleSafetyPad,
      maxX: vw / 2 - w / 2 - edgePad - bubbleSafetyPad,
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

    const dockedAgent = document.getElementById('agentNode')
    if (dockedAgent?.dataset?.slot === 'navbar') {
      const br = dockedAgent.getBoundingClientRect()
      if (br.width >= 8 && br.height >= 8) {
        const navGap = vw < 768 ? 8 : 6
        const glued = this._glueLeftOfAgentRect(vw, vh, scale, br, navGap)
        if (glued) return glued
      }
    }

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
    this._startTrailLoop()

    // No wobble when content open
    const wobble =
      document.body.classList.contains('content-open') ||
      document.body.classList.contains('project-dialog-open') ||
      document.body.classList.contains('chat-dialog-open') ||
      document.body.classList.contains('contact-dialog-open')
        ? 0
        : (Math.random() - 0.5) * 5;

    this.movable.style.setProperty('--sx', `${x + wobble}px`);
    this.movable.style.setProperty('--sy', `${y + wobble}px`);
    this.movable.style.setProperty('--ss', `${scale}`);
    this.currentScale = scale;
    this._updateTrail()

    const cleanup = () => {
      this.movable.classList.remove('thrust', 'moving');
      this.movable.removeEventListener('transitionend', onEnd);
      this._stopTrailLoop()
      this._updateTrail()
    };

    const onEnd = (e) => {
      if (e.propertyName === 'transform') cleanup();
    };

    if (this._onEnd) this.movable.removeEventListener('transitionend', this._onEnd);
    this._onEnd = onEnd;
    this.movable.addEventListener('transitionend', onEnd);

    this._cleanupTimer = setTimeout(cleanup, this.options.transitionSpeed * 1000 + 50);
  }

  _startTrailLoop() {
    if (this._trailLoopRaf) return
    const tick = () => {
      this._trailLoopRaf = null
      if (!this.movable.classList.contains('moving')) return
      this._updateTrail()
      this._trailLoopRaf = requestAnimationFrame(tick)
    }
    this._trailLoopRaf = requestAnimationFrame(tick)
  }

  _stopTrailLoop() {
    if (!this._trailLoopRaf) return
    cancelAnimationFrame(this._trailLoopRaf)
    this._trailLoopRaf = null
  }

  updateTrail() {
    this._updateTrail()
  }

  setTrailVisible(visible) {
    this._trailVisible = Boolean(visible)
    if (!this.agentTrail) return
    this.agentTrail.classList.toggle('agent-trail--hidden', !this._trailVisible)
    this.agentTrail.setAttribute('aria-hidden', 'true')
    if (!this._trailVisible) {
      this.agentTrail.style.opacity = '0'
      this.agentTrail.style.pointerEvents = 'none'
      return
    }
    this.agentTrail.style.opacity = ''
    this.agentTrail.style.pointerEvents = 'none'
    this._updateTrail()
  }

  _updateTrail() {
    const trail = this.agentTrail || document.getElementById('agentTrail')
    const node = this.agentNode || document.getElementById('agentNode')
    if (!trail || !node) return
    const dots = trail.querySelectorAll('.agent-trail__dot')
    if (!dots.length) return

    if (!this._trailVisible || this.isQuiet) {
      trail.classList.add('agent-trail--hidden')
      return
    }

    const dialogOpen = document.body.classList.contains('chat-dialog-open')
      || document.body.classList.contains('project-dialog-open')
      || document.body.classList.contains('contact-dialog-open')
    if (dialogOpen) {
      trail.classList.add('agent-trail--hidden')
      return
    }

    const anchorEl = this.spaceman.querySelector('.helmet') || this.spaceman.querySelector('.hero-head')
    if (!anchorEl) {
      trail.classList.add('agent-trail--hidden')
      return
    }

    const a = anchorEl.getBoundingClientRect()
    const b = node.getBoundingClientRect()
    if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
      trail.classList.add('agent-trail--hidden')
      return
    }

    const ax = a.left + a.width / 2
    const ay = a.top + a.height / 2
    const bx = Math.max(b.left, Math.min(ax, b.right))
    const by = Math.max(b.top, Math.min(ay, b.bottom))
    const rdx = bx - ax
    const rdy = by - ay
    const rlen = Math.hypot(rdx, rdy) || 1
    /* Long chords: shallower arc + lower t so dots stay nearer the helmet (less “stretched” line) */
    const stretch = Math.min(1, Math.max(0, (rlen - 64) / 260))
    const bulgeMag = Math.max(7, 16 - 9 * stretch)
    const ts = [
      0.22 + (0.12 - 0.22) * stretch,
      0.52 + (0.32 - 0.52) * stretch,
      0.8 + (0.55 - 0.8) * stretch
    ]
    let ox = (-rdy / rlen) * bulgeMag
    let oy = (rdx / rlen) * bulgeMag
    if (oy > 0) {
      ox = -ox
      oy = -oy
    }
    const cx = (ax + bx) / 2 + ox
    const cy = (ay + by) / 2 + oy
    const quad = (t) => {
      const u = 1 - t
      return {
        x: u * u * ax + 2 * u * t * cx + t * t * bx,
        y: u * u * ay + 2 * u * t * cy + t * t * by
      }
    }

    dots.forEach((dot, index) => {
      const t = ts[index] ?? ts[ts.length - 1]
      const p = quad(t)
      dot.style.transform = `translate(${p.x}px, ${p.y}px)`
    })

    trail.classList.remove('agent-trail--hidden')
  }

  destroy() {
    clearTimeout(this._updateT);
    clearTimeout(this._cleanupTimer);
    clearTimeout(this._resizeTimer);
    clearTimeout(this._scrollTimer);
    this._clearPostDragCooldown();
    this._stopTrailLoop()
    if (this._onEnd) this.movable.removeEventListener('transitionend', this._onEnd);
    this._mutationObs?.disconnect();
    this._agentNodeMutationObs?.disconnect()
    this._resizeObs?.disconnect();
    this._contentEls?.forEach(el => el.removeEventListener('transitionend', this._onTransitionEnd));
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._onScrollLike) window.removeEventListener('scroll', this._onScrollLike);
    if (this._visualViewport && this._onScrollLike) {
      this._visualViewport.removeEventListener('scroll', this._onScrollLike);
      this._visualViewport.removeEventListener('resize', this._onScrollLike);
    }
    this._dragCleanup?.();
  }
}

export function initSpacemanPosition(spacemanElement, options) {
  return new SpacemanPosition(spacemanElement, options);
}

export { SpacemanPosition };
