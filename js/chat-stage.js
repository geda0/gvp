/**
 * The chat stage reducer (ADR-0015 §4). Two pure functions. No DOM, no store, no voice.
 *
 * NAMED `chat-stage`, NOT `chat-dock` as the plan says, on measured grounds: "dock" is
 * already taken in this codebase and means something else — `dockMode` / `setDockMode` /
 * `getEffectiveDockMode` (js/chat.js:512-525), `data-dock-mode` in the markup, and the
 * shipped `chat_dock_switch_*` analytics all mean the composer's TEXT-vs-VOICE mode. A second
 * "dock" with four unrelated states inside the same 2k-line file is a defect generator.
 *
 * `stageChrome` returns the accessibility contract AS DATA. That is what makes it assertable
 * with no DOM at all — this repo has zero test dependencies, no jsdom/linkedom/happy-dom — so
 * the contract can be pinned in `node --test` while the browser journey harness stays the
 * LAST slice of M2 rather than a prerequisite for any of it.
 *
 * VOICE IS NEITHER AN INPUT NOR AN OUTPUT (§4.3). `voiceActive` appears nowhere in
 * `nextChatStage`'s signature or body, and `ctx` is only read for `wide`. Every defect in §9
 * is "a layout change killed the session"; a reducer that cannot see voice cannot stop it.
 * That is the constructive half of invariant #20.
 */

/** @typedef {'closed' | 'modal' | 'docked' | 'minimized'} ChatStage */

export const CHAT_STAGE_EVENTS = Object.freeze([
  'open-text',
  'open-voice',
  'navigate',
  'project-open',
  'project-close',
  'contact-open',
  'contact-close',
  'escape',
  'restore',
  'minimize',
  'close',
  'viewport-narrow',
  'viewport-wide',
  // A visitor tapping "talk about this" inside a project dialog. Neither open-* nor
  // project-open expresses it: open-* always goes modal, which covers the dialog with the
  // chat's own backdrop, and project-open does not fire at all because the store's
  // `project` was written BEFORE the chat opened, so tapping a chip changes nothing.
  'open-beside'
])

const STAGES = Object.freeze(['closed', 'modal', 'docked', 'minimized'])

/**
 * @param {ChatStage} stage
 * @param {string} event
 * @param {{ wide?: boolean }} [ctx] `wide` is INJECTED — never read from the environment, or
 *   the reducer would behave differently in a unit test than in the journey harness.
 * @returns {ChatStage}
 */
export function nextChatStage (stage, event, ctx) {
  const yielded = ctx && ctx.wide ? 'docked' : 'minimized'

  switch (event) {
    // Opening is a VISITOR act and always focuses the panel, from any stage. On a wide
    // viewport the docked card IS the main chat (ADR-0027 §2.4): it opens there, floating
    // beside the site. Narrow keeps the modal - a card on a phone leaves no usable page.
    case 'open-text':
    case 'open-voice':
      return ctx && ctx.wide ? 'docked' : 'modal'

    // `restore` means "bring back the panel you already have". It cannot resurrect a CLOSED
    // conversation — opening is `open-*`. Keeping them distinct is what lets M4's launcher
    // "Assistant active" chip be a restore without becoming an accidental cold open.
    case 'restore':
      //
      // Wide: back to the main docked card (ADR-0027 §2.4), at whatever size the visitor
      // last chose - size is chat-local and never a reducer input.
      if (stage === 'closed') return 'closed'
      return ctx && ctx.wide ? 'docked' : 'modal'

    // Site events. `closed` is ABSORBING for all of them: a visitor who has never opened the
    // chat must not acquire a dock on their first nav click — the single most likely way to
    // turn "the assistant yields the stage" into "the assistant is always on screen".
    //
    // They are also IDEMPOTENT in the yielded stages: a second navigation while docked does
    // not re-promote to modal. Promotion is a visitor act only.
    case 'navigate':
    case 'project-open':
      if (stage === 'closed') return 'closed'
      if (stage === 'modal') return yielded
      return stage

    // contact-open → minimized at EVERY width, not just narrow. The contact dialog is itself
    // aria-modal and binds Escape; a docked card beside it competes for the same key and the
    // same focus ring.
    case 'contact-open':
      return stage === 'closed' ? 'closed' : 'minimized'

    // The RETURN PATH. Without it, a visitor who opens a project dialog and closes it again
    // is left with a pill and no stage, and an agent mid-sentence has nowhere to speak from.
    // A dialog closing never DEMOTES an already-focused panel.
    case 'project-close':
    case 'contact-close':
      if (stage === 'minimized') return yielded
      return stage

    case 'escape':
      // From modal, Escape closes — today's shipped behaviour, preserved deliberately.
      if (stage === 'modal') return 'closed'
      // From docked it yields further rather than closing.
      if (stage === 'docked') return 'minimized'
      // From minimized it is a NO-OP: a pill has nothing to dismiss, and Escape then almost
      // always means "close the dialog in front of me". Destroying a minimized conversation
      // would discard the transcript on a keystroke aimed at something else.
      return stage

    case 'minimize':
      return stage === 'closed' ? 'closed' : 'minimized'

    case 'close':
      return 'closed'

    // Width never changes a FOCUSED panel — the visitor is looking at it. And widening does
    // NOT auto-promote a pill: the visitor minimized it, and a resize is not consent.
    case 'viewport-narrow':
      return stage === 'docked' ? 'minimized' : stage
    case 'viewport-wide':
      return stage

    // Dock BESIDE the dialog when the measured geometry allows it, else take the screen.
    // `closed` is deliberately NOT absorbing here: ss4.3 note 2 makes it absorbing for SITE
    // events so a visitor who never opened the chat cannot acquire a dock by navigating,
    // but this is not a site event - it is a visitor asking to talk, and opening is exactly
    // what it is for.
    case 'open-beside':
      return ctx && ctx.roomBeside ? 'docked' : 'modal'

    default:
      // An unknown event is INERT, not fatal: a reducer that throws on one turns a typo in a
      // caller into a broken chat.
      return stage
  }
}

/**
 * Is there room for the docked card beside an open dialog, without overlapping it?
 *
 * A FUNCTION OF MEASURED WIDTHS, NOT A BREAKPOINT. The dialog's width has two regimes -
 * viewport-bound below ~704px, content-bound above - and the content-bound one is expressed
 * in `rem`. The root font-size is 16px today, but this site already drives other sizes off
 * viewport-relative clamps, so a future `html { font-size: clamp(...) }` would move the real
 * threshold while a hard-coded media query kept passing, silently, with a green suite.
 *
 * The MEASUREMENT lives in js/chat.js (one getBoundingClientRect on the dialog panel); the
 * DECISION lives here. Same split as the stage reducer and the precipitation leaf, for the
 * same reason: the half that needs a compositor should be the half with no logic in it.
 *
 * @param {{viewportWidth: number, dialogWidth: number, cardWidth: number, gutter: number}} m
 */
export function hasRoomBesideDialog (m) {
  if (!m) return false
  const { viewportWidth, dialogWidth, cardWidth, gutter } = m
  // A measurement that did not happen must not read as room. The caller measures a live
  // element, and before the dialog exists that rect is all zeros - a predicate that said
  // `true` on zeros would dock the chat beside a dialog that is not there.
  for (const v of [viewportWidth, dialogWidth, cardWidth, gutter]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false
  }
  if (viewportWidth <= 0 || dialogWidth <= 0 || cardWidth <= 0) return false
  return (viewportWidth - dialogWidth) / 2 >= cardWidth + gutter
}

// ---------------------------------------------------------------- size (ADR-0027 §3)
//
// SIZE IS ORTHOGONAL TO STAGE. `docked` at wide and `docked` at compact have identical chrome
// (stageChrome never sees size), so size is a second dimension of the docked card, held in
// js/chat.js and never fed to nextChatStage. Everything here takes plain numbers.

export const CHAT_SIZES = Object.freeze(['wide', 'compact'])
// Owner decision (2026-10-24): the first open is WIDE.
export const DEFAULT_CHAT_SIZE = 'wide'

/**
 * A stored preference is visitor-controlled data, so anything that is not exactly one of the
 * two sizes reads as the default - no case folding, no guessing.
 * @returns {'wide' | 'compact'}
 */
export function parseChatSize (raw) {
  return raw === 'compact' ? 'compact' : DEFAULT_CHAT_SIZE
}

// == min(24rem, 100vw - 2rem) at a 16px root, browser-measured (ADR-0017 §2.4).
export const DOCK_COMPACT_WIDTH = 384
// The `- 2rem` in that rule, per side.
export const DOCK_EDGE_INSET = 16
// The docked shell's padding at >= 1000px, and the gutter hasRoomBesideDialog is fed.
export const DOCK_GUTTER = 20
export const DOCK_WIDE_MAX_WIDTH = 720
// Below this "wide" is not meaningfully wider than compact, so it falls back instead.
export const DOCK_WIDE_MIN_WIDTH = 480
// px of page the card must ALWAYS leave beside it (invariant #27). 320 is the narrowest
// layout the site already supports, so the uncovered strip is always a usable column -
// "floats, may cover part of the content" is the owner's ruling; "the site stays usable"
// is his constraint, and it has to be a number to be testable.
export const DOCK_MIN_UNCOVERED = 320

/**
 * The docked card's width in px - the ONE source of truth for it. CSS reads it back as
 * --chat-dock-width; hasRoomBesideDialog is fed the same number.
 *
 * `0` means "not measurable": the caller removes the custom property and the CSS fallback
 * (the shipped compact rule) applies.
 * @param {{viewportWidth: number, size: string}} m
 */
export function dockedCardWidth ({ viewportWidth, size } = {}) {
  if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth) || viewportWidth < 0) {
    return 0
  }
  const compact = Math.max(0, Math.min(DOCK_COMPACT_WIDTH, viewportWidth - 2 * DOCK_EDGE_INSET))
  if (size !== 'wide') return compact
  const wide = Math.min(DOCK_WIDE_MAX_WIDTH, viewportWidth - 2 * DOCK_GUTTER - DOCK_MIN_UNCOVERED)
  return wide < DOCK_WIDE_MIN_WIDTH ? compact : wide
}

// ---------------------------------------------------------------- beside a dialog (ADR-0029 §2)
//
// Measured once (ADR-0017 §2.4, browser): .project-dialog__panel content-bound width at a 16 px
// root = 42rem (672) + padding-inline 1.35rem (21.6) + 2.75rem (44) + 2 x 1px border = 739.6.
// test/chat-stage-layering.test.mjs recomputes it from css/styles.css, so the two cannot drift.
export const PROJECT_PANEL_MAX = 739.6
// Below this the panel is too narrow to read beside the chat (owner/RCA call).
export const PROJECT_PANEL_MIN = 560
// .project-dialog's `padding: 1rem`, per side.
export const PROJECT_DIALOG_PADDING = 16

/**
 * Does a project dialog leave room for the chat's column, and at which size? A function of the
 * viewport alone: the panel no longer has a fixed width beside the chat (it shrinks into the
 * space the reserve leaves), so there is nothing stable to measure.
 *
 * `size` is the EFFECTIVE size only - it never overwrites the stored preference. `reserve` is
 * the inline-end px the dialog gives up (0 = no room: nothing reserved). An unmeasured viewport
 * is not room.
 *
 * @param {{ viewportWidth: number, preferred: string }} m
 * @returns {{ size: 'wide'|'compact', reserve: number, panelMax: number }}
 */
export function besideLayout ({ viewportWidth, preferred } = {}) {
  const want = parseChatSize(preferred)
  const valid = typeof viewportWidth === 'number' && Number.isFinite(viewportWidth) && viewportWidth >= 0
  const vw = valid ? viewportWidth : 0
  const reserveFor = (size) => dockedCardWidth({ viewportWidth: vw, size }) + 2 * DOCK_GUTTER
  const panelFor = (size) => Math.min(PROJECT_PANEL_MAX, vw - reserveFor(size) - 2 * PROJECT_DIALOG_PADDING)
  if (valid) {
    for (const size of want === 'wide' ? ['wide', 'compact'] : ['compact']) {
      // A wide that falls back to compact width (dockedCardWidth's own floor) is not wide.
      if (size === 'wide' && !isWideAvailable(vw)) continue
      if (panelFor(size) >= PROJECT_PANEL_MIN) {
        return { size, reserve: reserveFor(size), panelMax: panelFor(size) }
      }
    }
  }
  return {
    size: want,
    reserve: 0,
    panelMax: Math.max(0, Math.min(PROJECT_PANEL_MAX, vw - 2 * PROJECT_DIALOG_PADDING))
  }
}

/** Can a wide card render at all at this viewport width? (>= 840px with today's numbers.) */
export function isWideAvailable (viewportWidth) {
  if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth)) return false
  return Math.min(DOCK_WIDE_MAX_WIDTH, viewportWidth - 2 * DOCK_GUTTER - DOCK_MIN_UNCOVERED) >=
    DOCK_WIDE_MIN_WIDTH
}

/**
 * The size contract as data (ADR-0027 §3.3), applied by js/chat.js's applyChatSize alone.
 *
 * `beside`: a project dialog is showing (ADR-0029 §2.1). Beside one, wide renders only where
 * besideLayout reserves a WIDE column, so the size returned here always equals besideLayout's.
 *
 * The effective size never overwrites `preferred`: a fallback renders compact while the
 * preference stays wide, so widening the window or closing the dialog brings wide back with
 * no visitor act. The toggle is HIDDEN, not disabled, when wide cannot render - a control
 * that does nothing is noise to a screen reader.
 *
 * @param {{stage: ChatStage, viewportWidth: number, preferred: string, beside: boolean}} m
 */
export function dockedSizeChrome ({ stage, viewportWidth, preferred, beside } = {}) {
  const canGoWide = isWideAvailable(viewportWidth) && (
    !beside || besideLayout({ viewportWidth, preferred: 'wide' }).size === 'wide'
  )
  const size = parseChatSize(preferred) === 'wide' && canGoWide ? 'wide' : 'compact'
  return {
    size,
    width: dockedCardWidth({ viewportWidth, size }),
    toggleHidden: stage !== 'docked' || !canGoWide,
    togglePressed: size === 'wide' ? 'true' : 'false'
  }
}

/**
 * Where focus goes on entering a yielded stage.
 *  - `docked` by REQUEST focuses the composer; `docked` by yield does not.
 *  - `minimized` by request FROM A FOCUSED CARD (ADR-0027 §5.2) hands focus to the resume
 *    chip: the pill has no composer, and now that docked is the main window, Escape or the
 *    minimise button would otherwise drop focus to <body>. A system minimise (contact-open)
 *    never moves it - the contact dialog is taking focus.
 */
function yieldedFocus (stage, opts) {
  const requested = Boolean(opts && opts.requested)
  if (stage === 'docked') return requested ? 'composer' : 'none'
  return requested && opts.focusInside ? 'resume-chip' : 'none'
}

/**
 * The normative accessibility contract per stage (§4.4), as data.
 *
 * `opts.requested` says the visitor ASKED for this stage rather than being yielded into it,
 * and it changes exactly one cell: focus. ADR-0015 §4.4 argues that entering `docked` must
 * not move focus, because stealing focus back into the chat is the keyboard equivalent of
 * the modal that milestone removed - but that argument is about a YIELD. A visitor who taps
 * "talk about this" asked for the composer, and leaving focus in the project dialog means a
 * keyboard visitor taps the chip and then has to hunt for what they just opened.
 *
 * Widened here rather than handled in js/chat.js's glue: the whole point of returning the
 * contract as DATA is that it is assertable in a repo with no jsdom, and one case handled
 * imperatively would be the single cell of the table nothing checks - the exception, which
 * is the cell most likely to be wrong.
 *
 * @param {ChatStage} stage
 * @param {{requested?: boolean, focusInside?: boolean}} [opts] `focusInside`: was
 *   document.activeElement inside the panel BEFORE this stage applied (the glue measures it).
 */
export function stageChrome (stage, opts) {
  switch (stage) {
    case 'closed':
      return {
        dialogHidden: true,
        backdropHidden: true,
        scrollLock: false,
        ariaModal: 'false',
        moveFocus: 'restore',
        pointerEventsOnShell: 'none'
      }
    case 'modal':
      return {
        dialogHidden: false,
        backdropHidden: false,
        scrollLock: true,
        ariaModal: 'true',
        moveFocus: 'composer',
        pointerEventsOnShell: 'auto'
      }
    // docked and minimized are the YIELDED stages, and this is the milestone's whole claim:
    //   - backdrop HIDDEN, never faded. It is a real inset:0 element (index.html:299) with
    //     backdrop-filter; an opacity:0 full-viewport element still consumes every click,
    //     which would leave the site visually operable and functionally dead.
    //   - no scroll lock. css/chat.css:1-3 (body.chat-dialog-open) is the only one.
    //   - aria-modal="false". It is STATIC in the markup today; a yielded card still claiming
    //     true tells a screen reader the rest of the page does not exist.
    //   - focus stays where the visitor put it, and the fixed shell must not swallow pointers.
    case 'docked':
    case 'minimized':
      return {
        dialogHidden: false,
        backdropHidden: true,
        scrollLock: false,
        ariaModal: 'false',
        moveFocus: yieldedFocus(stage, opts),
        pointerEventsOnShell: 'none'
      }
    default:
      throw new TypeError(
        `stageChrome: unknown stage ${JSON.stringify(stage)}; expected one of ${STAGES.join(' | ')}. ` +
        'Returning closed-like chrome instead would hide the bug behind a blank screen.'
      )
  }
}
