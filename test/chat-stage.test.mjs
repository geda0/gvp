import test from 'node:test'
import assert from 'node:assert/strict'

import { nextChatStage, stageChrome, CHAT_STAGE_EVENTS } from '../js/chat-stage.js'

// The stage reducer (ADR-0015 §4). Two pure functions, no DOM, no store.
//
// WHY `chat-stage.js` AND NOT `chat-dock.js` as the plan says: MEASURED, "dock" is already
// taken in this codebase and means something else — `dockMode` / `setDockMode` /
// `getEffectiveDockMode` (js/chat.js:512-525), `data-dock-mode` in the markup, and shipped
// `chat_dock_switch_*` analytics all mean the composer's TEXT-vs-VOICE mode. A second "dock"
// with four unrelated states inside the same 2k-line file is a defect generator.
//
// WHY `stageChrome` RETURNS DATA: it makes the accessibility contract assertable with NO DOM
// at all, which matters because this repo has zero test dependencies — no jsdom, no
// linkedom, no happy-dom (see the house rule noted in test/starfield-perf.test.mjs). A
// reducer that returned DOM mutations could only be tested in a browser, and the browser
// harness is deliberately the LAST slice of M2.
//
// VOICE IS NEITHER AN INPUT NOR AN OUTPUT (§4.3). `voiceActive` must not appear in
// nextChatStage's signature or body. Every defect in §9 is "a layout change killed the
// session"; a reducer that cannot see voice cannot stop it. That is the constructive half of
// invariant #20, whose destructive half is already pinned by
// test/site-events-never-stop-voice.test.mjs.
//
// The table below is ADR-0015 §4.3 transcribed. The cases the PLAN does not state are marked
// — they are the ones most likely to be "simplified" away by someone reading only the plan.

const W = (wide) => (wide ? 'docked' : 'minimized')

// [event, from, expectedWide, expectedNarrow, note]
const TABLE = [
  // ADR-0027 §2.4 SUPERSEDES the wide column of these rows (deliberate test-writer change,
  // not a regression): on a wide viewport the docked card IS the main window, so every
  // visitor open lands `docked`. The narrow column is unchanged — a phone still gets modal.
  ['open-text', 'closed', 'docked', 'modal', 'ADR-0027'],
  ['open-voice', 'closed', 'docked', 'modal', 'ADR-0027'],
  ['open-text', 'minimized', 'docked', 'modal', 'ADR-0027'],
  ['open-voice', 'minimized', 'docked', 'modal', 'ADR-0027'],
  ['open-text', 'docked', 'docked', 'modal', 'ADR-0027'],
  // From modal on a wide viewport (open-beside with no room, or a viewport that widened
  // under a modal) a re-open docks: re-opening is a visitor act (ADR-0027 §2.4 note 1).
  ['open-text', 'modal', 'docked', 'modal', 'ADR-0027'],
  ['open-voice', 'modal', 'docked', 'modal', 'ADR-0027'],

  // restore cannot resurrect a closed conversation — opening is open-*. Keeping them
  // distinct is what lets M4's "Assistant active" chip restore without a cold open.
  ['restore', 'closed', 'closed', 'closed', 'PLAN-SILENT'],
  // ADR-0027 §2.4: restore on wide comes back to the main window (docked), not a modal.
  // Deliberate test-writer change; narrow column unchanged.
  ['restore', 'minimized', 'docked', 'modal', 'ADR-0027'],
  ['restore', 'modal', 'docked', 'modal', 'ADR-0027'],
  ['restore', 'docked', 'docked', 'modal', 'ADR-0027'],

  // `closed` is ABSORBING for every site event. A visitor who never opened the chat must not
  // acquire a dock on their first nav click — the single most likely way to turn "the
  // assistant yields the stage" into "the assistant is always on screen".
  ['navigate', 'closed', 'closed', 'closed', 'PLAN-SILENT'],
  ['project-open', 'closed', 'closed', 'closed', 'PLAN-SILENT'],
  ['contact-open', 'closed', 'closed', 'closed', 'PLAN-SILENT'],

  ['navigate', 'modal', 'docked', 'minimized'],
  ['project-open', 'modal', 'docked', 'minimized'],

  // Site events are IDEMPOTENT in the yielded stages: a second navigation while docked does
  // not re-promote. Promotion is a visitor act only.
  ['navigate', 'docked', 'docked', 'docked', 'PLAN-SILENT'],
  ['navigate', 'minimized', 'minimized', 'minimized', 'PLAN-SILENT'],
  ['project-open', 'docked', 'docked', 'docked', 'PLAN-SILENT'],

  // contact-open → minimized at EVERY width. The contact dialog is itself aria-modal and
  // binds Escape; a docked card beside it competes for the same key and focus ring.
  ['contact-open', 'modal', 'minimized', 'minimized', 'PLAN-SILENT'],
  ['contact-open', 'docked', 'minimized', 'minimized', 'PLAN-SILENT'],

  // The RETURN PATH, which the plan omits entirely. Without it a visitor who opens a project
  // and closes it is left with a pill and no stage, and an agent mid-sentence has nowhere to
  // speak from.
  ['project-close', 'minimized', 'docked', 'minimized', 'PLAN-SILENT'],
  ['contact-close', 'minimized', 'docked', 'minimized', 'PLAN-SILENT'],
  // A dialog closing never DEMOTES an already-focused panel.
  ['project-close', 'modal', 'modal', 'modal'],
  ['contact-close', 'docked', 'docked', 'docked'],

  // Escape from modal closes — today's shipped behaviour (js/chat.js Escape → closePanel),
  // preserved deliberately, no migration.
  ['escape', 'modal', 'closed', 'closed'],
  ['escape', 'docked', 'minimized', 'minimized', 'PLAN-SILENT'],
  // Escape from minimized is a NO-OP. A pill has nothing to dismiss, and Escape then almost
  // always means "close the dialog in front of me". Destroying a minimized conversation
  // would discard the transcript on a keystroke aimed at something else.
  ['escape', 'minimized', 'minimized', 'minimized', 'PLAN-SILENT'],
  ['escape', 'closed', 'closed', 'closed'],

  ['minimize', 'modal', 'minimized', 'minimized'],
  ['minimize', 'docked', 'minimized', 'minimized'],
  ['close', 'modal', 'closed', 'closed'],
  ['close', 'docked', 'closed', 'closed'],
  ['close', 'minimized', 'closed', 'closed'],

  // Width never changes a FOCUSED panel — the visitor is looking at it.
  ['viewport-narrow', 'modal', 'modal', 'modal'],
  ['viewport-wide', 'modal', 'modal', 'modal'],
  ['viewport-narrow', 'docked', 'minimized', 'minimized'],
  // Widening does NOT auto-promote a pill: the visitor minimized it, a resize is not consent.
  ['viewport-wide', 'minimized', 'minimized', 'minimized', 'PLAN-SILENT']
]

test('the transition table matches ADR-0015 §4.3 exactly', () => {
  const wrong = []
  for (const [event, from, expWide, expNarrow, note] of TABLE) {
    for (const [wide, expected] of [[true, expWide], [false, expNarrow]]) {
      const got = nextChatStage(from, event, { wide })
      if (got !== expected) {
        wrong.push(
          `${event} from ${from} (wide=${wide}): got ${got}, expected ${expected}` +
          (note === 'PLAN-SILENT' ? `  [${note}: stated in the ADR, NOT in the plan]` : '') +
          (note && note !== 'PLAN-SILENT' ? `  [${note}]` : '')
        )
      }
    }
  }
  assert.deepEqual(
    wrong, [],
    'transitions disagree with ADR-0015 §4.3:\n  ' + wrong.join('\n  ')
  )
})

test('an unknown event leaves the stage untouched rather than throwing', () => {
  for (const stage of ['closed', 'modal', 'docked', 'minimized']) {
    assert.equal(
      nextChatStage(stage, 'not-a-real-event', { wide: true }), stage,
      'an unknown event must be inert — a reducer that throws on one turns a typo in a ' +
      'caller into a broken chat'
    )
  }
})

test('voice is neither an input nor an output of the reducer', () => {
  const src = nextChatStage.toString()
  assert.doesNotMatch(
    src, /voiceActive|voice[A-Z]/,
    'nextChatStage references voice state. §4.3 forbids it: every defect in §9 is "a layout ' +
    'change killed the session", and a reducer that cannot see voice cannot stop it.'
  )
  // And it must not be reachable via ctx either.
  assert.equal(
    nextChatStage('modal', 'navigate', { wide: true, voiceActive: true }),
    nextChatStage('modal', 'navigate', { wide: true }),
    'passing voiceActive in ctx must not change the outcome'
  )
})

test('ctx.wide is injected, never read from the environment', () => {
  // The reducer must be pure: no window.matchMedia, no innerWidth. If it read the
  // environment it would be untestable here and would behave differently in the journey
  // harness than in a unit test.
  const src = nextChatStage.toString()
  for (const forbidden of ['matchMedia', 'innerWidth', 'window', 'document']) {
    assert.doesNotMatch(
      src, new RegExp(forbidden),
      `nextChatStage touches ${forbidden} — ctx.wide must be injected (§4.2)`
    )
  }
})

test('every documented event name is accepted', () => {
  const expected = [
    'open-text', 'open-voice', 'navigate', 'project-open', 'project-close',
    'contact-open', 'contact-close', 'escape', 'restore', 'minimize', 'close',
    'viewport-narrow', 'viewport-wide',
    // M4 (ADR-0017 §2.5): a visitor tapping "talk about this" inside a project dialog.
    'open-beside'
  ]
  assert.deepEqual(
    [...CHAT_STAGE_EVENTS].sort(), expected.sort(),
    'the exported event list must match §4.3, so a caller can be checked against it'
  )
})

// ---------------------------------------------------------------- stageChrome (§4.4)

test('stageChrome is the normative accessibility contract from §4.4', () => {
  assert.deepEqual(stageChrome('closed'), {
    dialogHidden: true,
    backdropHidden: true,
    scrollLock: false,
    ariaModal: 'false',
    moveFocus: 'restore',
    pointerEventsOnShell: 'none'
  })
  assert.deepEqual(stageChrome('modal'), {
    dialogHidden: false,
    backdropHidden: false,
    scrollLock: true,
    ariaModal: 'true',
    moveFocus: 'composer',
    pointerEventsOnShell: 'auto'
  })
  assert.deepEqual(stageChrome('docked'), {
    dialogHidden: false,
    backdropHidden: true,
    scrollLock: false,
    ariaModal: 'false',
    moveFocus: 'none',
    pointerEventsOnShell: 'none'
  })
  assert.deepEqual(stageChrome('minimized'), {
    dialogHidden: false,
    backdropHidden: true,
    scrollLock: false,
    ariaModal: 'false',
    moveFocus: 'none',
    pointerEventsOnShell: 'none'
  })
})

test('the yielded stages leave the site operable — the milestone claim, as data', () => {
  for (const stage of ['docked', 'minimized']) {
    const c = stageChrome(stage)
    assert.equal(c.backdropHidden, true,
      `${stage} must HIDE the backdrop, not fade it. MEASURED: it is a real inset:0 element ` +
      '(index.html:299) with backdrop-filter; an opacity:0 full-viewport element still eats ' +
      'every click, leaving the site visually operable and functionally dead with a green suite.')
    assert.equal(c.scrollLock, false,
      `${stage} must not set body.chat-dialog-open — css/chat.css:1-3 is the only scroll ` +
      'lock, and one stray classList.add silently restores a locked page')
    assert.equal(c.ariaModal, 'false',
      `${stage} must say aria-modal="false". It is a STATIC attribute in the markup today ` +
      '(index.html:300); a yielded card still claiming true tells a screen reader the rest ' +
      'of the page does not exist — the precise opposite of this milestone')
    assert.equal(c.moveFocus, 'none',
      `${stage} must not move focus: the visitor is interacting with the SITE`)
    assert.equal(c.pointerEventsOnShell, 'none',
      `${stage} must not let the fixed shell swallow pointer events`)
  }
})

test('stageChrome refuses an unknown stage rather than inventing chrome', () => {
  assert.throws(
    () => stageChrome('wide'), /stage/i,
    'an unknown stage must throw — silently returning closed-like chrome would hide the bug ' +
    'behind a blank screen'
  )
})

// ---------------------------------------------------------------- M4 (ADR-0017 §2.4-2.6)

test('hasRoomBesideDialog is a function of measured widths, not a breakpoint', async () => {
  const { hasRoomBesideDialog } = await import('../js/chat-stage.js')

  // THE THREE BROWSER-MEASURED GEOMETRIES. The project panel is 739.59px wide and the
  // docked card 384px, both measured rather than computed from the CSS, because
  // `min(42rem, …)` plus padding-inline-end is not something to derive by hand.
  //
  // The plan said "≥1100px the dialog shifts left beside the docked card". Both halves are
  // wrong: centred, no-overlap needs W ≥ ~1547, and at 1512 — a common laptop — the two
  // still overlap by ~18px. 1100 is not close.
  const P = 739.59
  const C = 384
  const g = 20
  assert.equal(
    hasRoomBesideDialog({ viewportWidth: 1280, dialogWidth: P, cardWidth: C, gutter: g }), false,
    'at 1280 browser-measurement puts 134 of the card\'s 384px behind the dialog panel'
  )
  assert.equal(
    hasRoomBesideDialog({ viewportWidth: 1512, dialogWidth: P, cardWidth: C, gutter: g }), false,
    'at 1512 they still overlap by ~18px — this is the row that makes the plan\'s 1100 ' +
    'obviously wrong rather than arguably wrong'
  )
  assert.equal(
    hasRoomBesideDialog({ viewportWidth: 1600, dialogWidth: P, cardWidth: C, gutter: g }), true
  )

  // The boundary is arithmetic, not a constant: (W - dialog) / 2 >= card + gutter.
  const exact = P + 2 * (C + g)
  assert.equal(hasRoomBesideDialog({ viewportWidth: exact, dialogWidth: P, cardWidth: C, gutter: g }), true)
  assert.equal(hasRoomBesideDialog({ viewportWidth: exact - 1, dialogWidth: P, cardWidth: C, gutter: g }), false)

  // A MEASUREMENT THAT DID NOT HAPPEN MUST NOT READ AS ROOM. The caller measures a live
  // element; before the dialog exists that rect is 0, and a predicate that answered `true`
  // on zeros would dock the chat beside a dialog that is not there.
  for (const bad of [
    { viewportWidth: 0, dialogWidth: 0, cardWidth: 0, gutter: 0 },
    { viewportWidth: NaN, dialogWidth: P, cardWidth: C, gutter: g },
    { viewportWidth: 1600, dialogWidth: NaN, cardWidth: C, gutter: g },
    {},
    null
  ]) {
    assert.equal(
      hasRoomBesideDialog(bad), false,
      `${JSON.stringify(bad)} must answer false — an unmeasured geometry is not room`
    )
  }
})

test('open-beside docks when there is room and goes modal when there is not', async () => {
  const { nextChatStage, CHAT_STAGE_EVENTS } = await import('../js/chat-stage.js')

  assert.ok(
    CHAT_STAGE_EVENTS.includes('open-beside'),
    'the event must be in the exported list, which test/chat-stage-wiring.test.mjs checks ' +
    'every member of for a caller'
  )

  for (const from of ['closed', 'modal', 'docked', 'minimized']) {
    assert.equal(
      nextChatStage(from, 'open-beside', { roomBeside: true }), 'docked',
      `open-beside from ${from} with room must dock`
    )
    assert.equal(
      nextChatStage(from, 'open-beside', { roomBeside: false }), 'modal',
      `open-beside from ${from} without room must go modal — on a phone, beside is not a ` +
      'place, and a docked card there would cover the dialog it is meant to discuss'
    )
  }

  // `closed` IS NOT ABSORBING for this one event, deliberately. §4.3 note 2 makes closed
  // absorbing for SITE events so a visitor who never opened the chat cannot acquire a dock
  // by navigating. open-beside is not a site event: it is a visitor tapping "talk about
  // this", and opening is exactly what it is for.
  assert.equal(nextChatStage('closed', 'open-beside', { roomBeside: true }), 'docked')

  // ctx.wide is a SEPARATE key and must not be confused with roomBeside: wide governs the
  // yield events, roomBeside governs this one.
  assert.equal(
    nextChatStage('closed', 'open-beside', { wide: true, roomBeside: false }), 'modal',
    'a wide viewport with no room beside the dialog is still modal'
  )
  assert.equal(
    nextChatStage('modal', 'navigate', { wide: true, roomBeside: false }), 'docked',
    'and roomBeside must not leak into the yield events'
  )
})

test('stageChrome moves focus when the stage was REQUESTED, not when it was yielded to', async () => {
  const { stageChrome } = await import('../js/chat-stage.js')

  // ADR-0015 §4.4 argues hard that entering docked must not move focus — "stealing focus
  // back into the chat is the keyboard equivalent of the modal this milestone removes."
  // That argument is about a YIELD. open-beside is a REQUEST: the visitor tapped "talk
  // about this", so the composer is the thing they asked for, and leaving focus in the
  // project dialog means a keyboard visitor taps the chip and nothing is reachable without
  // hunting for it.
  assert.equal(stageChrome('docked').moveFocus, 'none', 'yielding still must not move focus')
  assert.equal(stageChrome('docked', { requested: true }).moveFocus, 'composer')

  // Every other cell is unchanged, and the default argument reproduces the old table byte
  // for byte — that is what makes this additive rather than a revision.
  for (const stage of ['closed', 'modal', 'docked', 'minimized']) {
    const plain = stageChrome(stage)
    const defaulted = stageChrome(stage, {})
    assert.deepEqual(defaulted, plain, `${stage}: an empty opts must change nothing`)

    const requested = stageChrome(stage, { requested: true })
    const { moveFocus: _a, ...restPlain } = plain
    const { moveFocus: _b, ...restRequested } = requested
    assert.deepEqual(
      restRequested, restPlain,
      `${stage}: requested may only affect moveFocus — not the backdrop, the scroll lock, ` +
      'aria-modal or pointer events'
    )
  }

  assert.equal(
    stageChrome('minimized', { requested: true }).moveFocus, 'none',
    'a minimised pill has no composer to focus, so requested changes nothing there'
  )
})

// ---------------------------------------------------------------- ADR-0027: wide + compact

// The size dimension is ORTHOGONAL to the stage (ADR-0027 §2): a pure geometry seam in
// js/chat-stage.js, beside hasRoomBesideDialog, taking plain numbers and never `window`.
// Imported per test so a missing export fails as an assertion, not as an import error.
const sizeApi = () => import('../js/chat-stage.js')

test('parseChatSize reads only the two sizes, and anything else is the WIDE default', async () => {
  const { parseChatSize, CHAT_SIZES, DEFAULT_CHAT_SIZE } = await sizeApi()
  assert.equal(typeof parseChatSize, 'function', 'parseChatSize must be exported (ADR-0027 §3)')
  assert.deepEqual([...CHAT_SIZES], ['wide', 'compact'])
  assert.equal(DEFAULT_CHAT_SIZE, 'wide', 'owner decision O1: the first open is WIDE')
  // A stored value is visitor-controlled data: case is NOT folded, so 'WIDE' is junk, and
  // junk reads as the default rather than as whatever it happens to resemble.
  for (const raw of [null, undefined, '', 'WIDE', 'huge', 42]) {
    assert.equal(parseChatSize(raw), 'wide', `${JSON.stringify(raw)} must read as 'wide'`)
  }
  assert.equal(parseChatSize('wide'), 'wide')
  assert.equal(parseChatSize('compact'), 'compact')
})

test('the compact card is byte-identical to the shipped min(24rem, 100vw - 2rem)', async () => {
  const { dockedCardWidth, DOCK_COMPACT_WIDTH, DOCK_EDGE_INSET } = await sizeApi()
  assert.equal(typeof dockedCardWidth, 'function', 'dockedCardWidth must be exported (ADR-0027 §3)')
  assert.equal(DOCK_COMPACT_WIDTH, 384, 'browser-measured docked card (ADR-0017 §2.4)')
  assert.equal(DOCK_EDGE_INSET, 16)
  // Compact must not move by a pixel: 384 at every docked width, the CSS clamp below it.
  for (const vw of [767, 768, 839, 840, 1024, 1080, 1280, 1920]) {
    assert.equal(dockedCardWidth({ viewportWidth: vw, size: 'compact' }), 384, `compact at ${vw}`)
  }
  assert.equal(dockedCardWidth({ viewportWidth: 400, size: 'compact' }), 368, '400 - 2*16')
  // An unknown size is compact - never a surprise wide card.
  assert.equal(dockedCardWidth({ viewportWidth: 1280, size: 'huge' }), 384)
})

test('the wide card leaves 320px of page and falls back to compact rather than a sliver', async () => {
  const { dockedCardWidth, DOCK_WIDE_MAX_WIDTH, DOCK_WIDE_MIN_WIDTH, DOCK_MIN_UNCOVERED, DOCK_GUTTER } = await sizeApi()
  assert.deepEqual(
    [DOCK_WIDE_MAX_WIDTH, DOCK_WIDE_MIN_WIDTH, DOCK_MIN_UNCOVERED, DOCK_GUTTER], [720, 480, 320, 20],
    'ADR-0027 §3 constants'
  )
  // wide = min(720, vw - 2*20 - 320), compact (384) when that is < 480. The derived numbers
  // in ADR-0027 §3.1: available from 840, capped at 720 from 1080.
  const wide = (vw) => dockedCardWidth({ viewportWidth: vw, size: 'wide' })
  assert.equal(wide(767), 384, '767: wide is not available, fallback to compact')
  assert.equal(wide(768), 384)
  assert.equal(wide(839), 384, '839 - 360 = 479 < 480 - a sliver is not wide')
  assert.equal(wide(840), 480, 'the first width at which wide exists')
  assert.equal(wide(1024), 664)
  assert.equal(wide(1080), 720, 'the cap is reached')
  assert.equal(wide(1280), 720)
  assert.equal(wide(1920), 720)
  // An unmeasured viewport is 0 - the caller then drops the custom property and the CSS
  // fallback (the shipped compact rule) applies.
  for (const size of ['wide', 'compact']) {
    assert.equal(dockedCardWidth({ viewportWidth: NaN, size }), 0, `NaN, ${size}`)
    assert.equal(dockedCardWidth({ viewportWidth: -5, size }), 0, `negative, ${size}`)
  }
})

test('isWideAvailable flips exactly at 840px', async () => {
  const { isWideAvailable } = await sizeApi()
  assert.equal(typeof isWideAvailable, 'function', 'isWideAvailable must be exported (ADR-0027 §3)')
  assert.equal(isWideAvailable(839), false)
  assert.equal(isWideAvailable(840), true)
  assert.equal(isWideAvailable(1920), true)
  assert.equal(isWideAvailable(NaN), false, 'an unmeasured viewport offers no wide card')
})

test('invariant #27: at every docked width, either size leaves 320px of the site uncovered', async () => {
  const { dockedCardWidth, DOCK_GUTTER, DOCK_EDGE_INSET, DOCK_MIN_UNCOVERED } = await sizeApi()
  // The breakpoint the reducer docks at (768, js/chat.js isWideViewport) is CONSISTENT with
  // the floor, not a second number: 768 - 384 - 2*16 = 352 >= 320. Changing either so that
  // this breaks has to go red here rather than quietly shipping a card that eats the page.
  assert.ok(
    768 - dockedCardWidth({ viewportWidth: 768, size: 'compact' }) - 2 * DOCK_EDGE_INSET >= DOCK_MIN_UNCOVERED,
    'the 768px docking breakpoint no longer clears the 320px usability floor'
  )
  const covered = []
  for (let vw = 768; vw <= 2560; vw++) {
    for (const size of ['wide', 'compact']) {
      const left = vw - dockedCardWidth({ viewportWidth: vw, size }) - 2 * DOCK_GUTTER
      if (left < DOCK_MIN_UNCOVERED) covered.push(`${size}@${vw}: ${left}px left`)
    }
  }
  assert.deepEqual(
    covered.slice(0, 5), [],
    'the docked card covers too much of the site - "the site stays usable" is the owner\'s ' +
    'constraint on the new default window (#27)'
  )
})

test('dockedSizeChrome: the effective size is the preference only where wide can render', async () => {
  const { dockedSizeChrome } = await sizeApi()
  assert.equal(typeof dockedSizeChrome, 'function', 'dockedSizeChrome must be exported (ADR-0027 §3.3)')
  const P = 739.59 // the browser-measured project panel (ADR-0017 §2.4)
  const at = (viewportWidth, besideDialogWidth, preferred = 'wide', stage = 'docked') =>
    dockedSizeChrome({ stage, viewportWidth, preferred, besideDialogWidth })

  // Not beside a dialog (null): wide where wide exists.
  assert.deepEqual(at(1280, null),
    { size: 'wide', width: 720, toggleHidden: false, togglePressed: 'true' })
  assert.deepEqual(at(1280, null, 'compact'),
    { size: 'compact', width: 384, toggleHidden: false, togglePressed: 'false' })
  // Below 840 wide cannot render: compact, and the toggle is HIDDEN, not disabled. The
  // preference is not overwritten - only the toggle writes it (that is the caller's half).
  assert.deepEqual(at(800, null),
    { size: 'compact', width: 384, toggleHidden: true, togglePressed: 'false' })

  // Beside a dialog: null and 0 are DIFFERENT. 0 is "beside a dialog nobody measured",
  // which is no room - the same rule as hasRoomBesideDialog.
  assert.equal(at(2560, 0).size, 'compact', 'an unmeasured dialog is not room for wide')
  assert.equal(at(2560, 0).toggleHidden, true)
  // (1920 - 739.59)/2 = 590.2 < 720 + 20 -> compact. Crossover 739.59 + 2*740 = 2219.59.
  assert.equal(at(1280, P).size, 'compact')
  assert.equal(at(1920, P).size, 'compact')
  assert.equal(at(2219, P).size, 'compact')
  assert.deepEqual(at(2220, P),
    { size: 'wide', width: 720, toggleHidden: false, togglePressed: 'true' })

  // The toggle exists only on the docked card.
  for (const stage of ['closed', 'modal', 'minimized']) {
    assert.equal(at(1280, null, 'wide', stage).toggleHidden, true, `toggle hidden in ${stage}`)
  }
})

test('minimising a focused card hands focus to the resume chip, and only then', () => {
  // ADR-0027 §5.2. Now that docked is the MAIN window, Escape / the minimise button hide the
  // composer that holds focus, which drops focus to <body>. A visitor request that leaves a
  // focused card goes to the "Assistant active" chip - whose click is `restore`.
  assert.equal(
    stageChrome('minimized', { requested: true, focusInside: true }).moveFocus, 'resume-chip'
  )
  // Every other combination keeps today's 'none': a SYSTEM minimise (contact-open) never
  // moves focus - the contact dialog is taking it - and focus elsewhere is not ours to move.
  assert.equal(stageChrome('minimized', { requested: false, focusInside: true }).moveFocus, 'none')
  assert.equal(stageChrome('minimized', { requested: true, focusInside: false }).moveFocus, 'none')
  assert.equal(stageChrome('minimized', { focusInside: true }).moveFocus, 'none')
  // And focusInside means nothing to the other stages.
  assert.equal(stageChrome('docked', { requested: true, focusInside: true }).moveFocus, 'composer')
  assert.equal(stageChrome('docked', { focusInside: true }).moveFocus, 'none')
})
