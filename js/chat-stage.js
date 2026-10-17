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
  'viewport-wide'
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
    // Opening is a VISITOR act and always focuses the panel, from any stage.
    case 'open-text':
    case 'open-voice':
      return 'modal'

    // `restore` means "bring back the panel you already have". It cannot resurrect a CLOSED
    // conversation — opening is `open-*`. Keeping them distinct is what lets M4's launcher
    // "Assistant active" chip be a restore without becoming an accidental cold open.
    case 'restore':
      return stage === 'closed' ? 'closed' : 'modal'

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

    default:
      // An unknown event is INERT, not fatal: a reducer that throws on one turns a typo in a
      // caller into a broken chat.
      return stage
  }
}

/**
 * The normative accessibility contract per stage (§4.4), as data.
 * @param {ChatStage} stage
 */
export function stageChrome (stage) {
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
        moveFocus: 'none',
        pointerEventsOnShell: 'none'
      }
    default:
      throw new TypeError(
        `stageChrome: unknown stage ${JSON.stringify(stage)}; expected one of ${STAGES.join(' | ')}. ` +
        'Returning closed-like chrome instead would hide the bug behind a blank screen.'
      )
  }
}
