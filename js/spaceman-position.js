// spaceman-position.js - Simplified positioning controller
// Anchors spaceman near dialog TOP-RIGHT, clamps to viewport, respects nav

import { PANEL_ANIM_MS } from './chat-panel-anim.js'

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
    this.isStaying = false;
    this._isDragging = false;
    this._dragReturnTimer = null;
    this._layoutCooldownUntil = 0;
    this._hooks = {};
    this.agentNode = document.getElementById('agentNode')
    /** Measured `body > header` height for bounds; refreshed each `_update`. */
    this._navChromeHeight = null

    this.init();
  }

  _readSiteHeaderHeightPx() {
    const header = document.querySelector('body > header')
    if (!header) return this.options.navHeight
    const h = header.getBoundingClientRect().height
    if (!Number.isFinite(h) || h < 8) return this.options.navHeight
    return Math.max(56, Math.round(h))
  }

  /** Navbar-docked agent: hero scrolled away or playground/portfolio. */
  _agentDockedInNavbar() {
    return document.getElementById('agentNode')?.dataset?.slot === 'navbar'
  }

  /**
   * Width of the home hero copy column when measurable; otherwise a capped “hero-width”
   * stand-in (~36rem max) for navbar nudges on subpages.
   */
  _readHeroContentWidthPx(vw) {
    const el = document.querySelector('#home .hero-copy') || document.querySelector('.hero-copy')
    const r = el?.getBoundingClientRect?.()
    if (r && r.width > 48) return Math.round(r.width)
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    return Math.round(Math.min(Math.max(280, vw - 40), 36 * rem))
  }

  /** Nudge spaceman down on home so the helmet clears the top edge (~⅛ hero band height). */
  _heroHeadroomLowerPx() {
    const hero = document.querySelector('#home .hero') || document.querySelector('.hero')
    const r = hero?.getBoundingClientRect?.()
    if (!r || r.height < 48) return 0
    return Math.round(r.height / 8)
  }

  /** Stronger upward glue + relaxed top clamp so the figure reads “in” the top bar beside the chat pill. */
  _navbarGlueVerticalTuning(ref, vw) {
    const isMobile = vw < 768
    const rh = Math.max(12, ref.height)
    if (isMobile) {
      const nudge = -Math.round(rh * 0.44) - 12
      const relax = 68
      return { nudge, relax }
    }
    /* Desktop: push toward the top of the safe band as far as clamps allow */
    const nudge = -Math.round(rh * 0.52) - 22
    const relax = 86
    return { nudge, relax }
  }

  /**
   * Mobile: nudge toward the centered chat pill by ~10% of hero-column width (px),
   * keeping a small legacy left bias so the figure still reads beside the strip.
   */
  _navbarGlueHorizontalNudgePx(vw) {
    if (vw >= 768) return 0
    const hw = this._readHeroContentWidthPx(vw)
    return Math.round(-6 + hw * 0.1)
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
    const siteHeader = document.querySelector('body > header')
    if (siteHeader) this._resizeObs.observe(siteHeader)

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
      this._agentNodeMutationObs = new MutationObserver(() => this.updatePosition())
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
    this._navChromeHeight = this._readSiteHeaderHeightPx()
    if (this.isStaying) {
      this._clampStayingIfNeeded();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 768;
    const isTablet = vw >= 768 && vw < 1024;

    let x = 0, y = 0, scale = 1;

    const dialogContent = this._getActiveDialogPanelRect();
    const content = dialogContent || this._getVisibleContent();

    if (content) {
        const dialogOpen = !!dialogContent;
        const navDocked =
          document.body.classList.contains('content-open') && this._agentDockedInNavbar()
        if (navDocked && !dialogOpen) {
          scale = isMobile
            ? (vw < 480 ? 0.36 : 0.38)
            : isTablet ? 0.52 : 0.6
        } else {
          scale = dialogOpen
            ? (isMobile ? 0.4 : isTablet ? 0.5 : 0.62)
            : isMobile ? 0.45 : isTablet ? 0.55 : 0.7;
        }
        const pos = this._calcPosition(vw, vh, content, scale);
        x = pos.x;
        y = pos.y;
    } else {
        /* Home hero: slightly smaller than legacy full-page scale, closer to docked agent */
        scale = isMobile ? (vw < 480 ? 0.4 : 0.46) : isTablet ? 0.5 : 0.54;
        let bounds = this._getBounds(vw, vh, scale);
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
        const agentNavBar = dockedAgent?.dataset?.slot === 'navbar'
        /**
         * Mobile + launcher in hero: stack on the chat pill — bbox left flush with pill left,
         * bottom slightly overlaps pill top so the figure reads “on” the bar (not the generic top band).
         */
        if (isMobile && !agentNavBar) {
          const b = this._getBounds(vw, vh, scale, { looserMobileHeroEdges: true })
          let ref = null
          if (slotRect && slotRect.width > 8 && slotRect.height > 8) {
            const nr = dockedAgent?.getBoundingClientRect?.()
            ref = (nr && nr.width > 8 && nr.height > 8) ? nr : slotRect
          }
          if (ref) {
            const stackIntoBarPx = vw < 480 ? 10 : 8
            const cx = ref.left + w / 2
            const cy = ref.top + stackIntoBarPx - h / 2
            x = clamp(cx - vw / 2, b.minX, b.maxX)
            y = clamp(cy - vh / 2, b.minY, b.maxY)
            placedHome = true
            bounds = b
          } else if (heroCopy) {
            const r = heroCopy.getBoundingClientRect()
            if (r.width > 0 && r.height > 0) {
              x = clamp(r.left - vw / 2 + 8, b.minX, b.maxX)
              y = b.minY
              placedHome = true
              bounds = b
            }
          }
        }
        const navGlue = agentNavBar
          ? (vw < 768 ? 7 : 5)
          : (vw < 768 ? 8 : 6)
        if (agentNavBar) {
          const nr = dockedAgent.getBoundingClientRect()
          const { nudge, relax } = this._navbarGlueVerticalTuning(nr, vw)
          const hx = this._navbarGlueHorizontalNudgePx(vw)
          const g = this._glueLeftOfAgentRect(vw, vh, scale, nr, navGlue, nudge, relax, hx)
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
          /* Mobile only: nudge figure upward vs slot/agent midline (feet ~ Grounded hint) */
          const heroMobileUpNudgePx = vw < 768 ? -36 : 0
          const g = this._glueLeftOfAgentRect(
            vw,
            vh,
            scale,
            ref,
            heroGlueGap,
            heroMobileUpNudgePx
          )
          if (g) {
            x = g.x
            y = g.y
            placedHome = true
          }
        }
        if (!placedHome && heroCopy && !isMobile) {
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
            y = clamp(0, bounds.minY, bounds.maxY)
          }
        } else if (!placedHome) {
          const desiredX = isMobile ? 32 : 0
          const desiredY = isMobile ? -30 : 0
          x = clamp(desiredX, bounds.minX, bounds.maxX)
          y = clamp(desiredY, bounds.minY, bounds.maxY)
        }

        const headroom = this._heroHeadroomLowerPx()
        if (headroom > 0) {
          const tailOpts = isMobile ? { looserMobileHeroEdges: true } : {}
          const bTail = this._getBounds(vw, vh, scale, tailOpts)
          y = clamp(y + headroom, bTail.minY, bTail.maxY)
        }
    }

    this._moveTo(x, y, scale);
  }

  /**
   * Place spaceman so its right edge sits `glueGap` px left of `ref` (agent or slot rect).
   * Vertical center tracks ref midline; clamps to viewport bounds.
   * @param {number} relaxMinYPx subtract from bounds.minY clamp only (navbar glue: sit higher).
   * @param {number} glueHxNudgePx add to launcher-relative cx before clamp (mobile navbar: nudge left).
   */
  _glueLeftOfAgentRect(vw, vh, scale, ref, glueGap, verticalNudgePx = 0, relaxMinYPx = 0, glueHxNudgePx = 0) {
    if (!ref || ref.width < 8 || ref.height < 8) return null
    const bounds = this._getBounds(vw, vh, scale, vw < 768 ? { looserMobileHeroEdges: true } : {})
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
    const rect = this.container.getBoundingClientRect()
    const baseW = (rect.width / (this.currentScale || 1)) || 200
    const baseH = (rect.height / (this.currentScale || 1)) || 320
    const w = baseW * scale
    const h = baseH * scale
    const cx = ref.left - glueGap - w / 2 + glueHxNudgePx
    const cy = ref.top + ref.height / 2 + verticalNudgePx
    const minY = bounds.minY - Math.max(0, relaxMinYPx)
    return {
      x: clamp(cx - vw / 2, bounds.minX, bounds.maxX),
      y: clamp(cy - vh / 2, minY, bounds.maxY)
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

  _getBounds(vw, vh, scale, opts = {}) {
    const navHeight = this._navChromeHeight ?? this._readSiteHeaderHeightPx()
    const dockClearance = this._getDockClearance()
    const loose = Boolean(opts.looserMobileHeroEdges && vw < 768)
    const edgePad = loose ? 8 : (vw < 768 ? 12 : this.options.edgePad);
    const bubbleSafetyPad = loose ? 12 : (vw < 768 ? 22 : 10);
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
        const navGap = vw < 768 ? 7 : 5
        const { nudge, relax } = this._navbarGlueVerticalTuning(br, vw)
        const hx = this._navbarGlueHorizontalNudgePx(vw)
        const glued = this._glueLeftOfAgentRect(vw, vh, scale, br, navGap, nudge, relax, hx)
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

    const reducedMotion =
      typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const chatPanelCadence =
      document.body.classList.contains('chat-dialog-open') && !reducedMotion;
    const transitionMs = chatPanelCadence
      ? PANEL_ANIM_MS
      : this.options.transitionSpeed * 1000;
    this._cleanupTimer = setTimeout(cleanup, transitionMs + 50);
  }

  destroy() {
    clearTimeout(this._updateT);
    clearTimeout(this._cleanupTimer);
    clearTimeout(this._resizeTimer);
    clearTimeout(this._scrollTimer);
    this._clearPostDragCooldown();
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
