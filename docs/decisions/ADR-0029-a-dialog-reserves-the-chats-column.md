# ADR-0029 — A dialog reserves the chat's column: `besideLayout`, one page-level inset, and focus-routed Escape

- **Status:** **Accepted (contract only — no code written by this ADR).** The seams below are what
  the test-writer builds failing tests against.
- **Date:** 2026-10-24
- **Source:** orchestrator RCA (2026-10-24), browser-measured with a CDP probe and a CSS prototype at
  1024/1180/1280/1440/1516/1920 px × {compact, wide}. Finding: with the docked card open and a
  project dialog opened over it (either order), the card sits at z 1085 **under** the dialog's
  `inset: 0` scrim (z 1100). At 1280 px the wide card overlaps the 739.6 px panel by 469.8 px and the
  compact one by 133.8 px; `elementFromPoint` over the composer returns the project panel or scrim.
  The conversation is on screen, blurred, and unreachable. The ADR-0027 lift (`data-chat-beside`,
  z 1102) only fires from a chip and only when the **centred** dialog leaves room
  (`hasRoomBesideDialog`, ≥ ~1547 px) — so on every common laptop it never fires.
- **Supersedes:** ADR-0017 **§2.4's rejection** — *"'The dialog shifts left' is REJECTED as a
  decision"* — and with it the `hasRoomBesideDialog` predicate (§2.4's seam) and ADR-0027 §9's
  "re-measured live panel" lift rule. ADR-0017 §2.4's *measurements* stand and are reused below.
- **Amends:** invariant **#22**'s ADR-0017 §9.1 clause, and one reducer cell family of ADR-0015
  §4.3 (`project-open`, §4). Invariant **#20** is untouched (layout only — no path here reaches
  `stopVoice`); **#27** is unaffected (the card's width is still `dockedCardWidth`'s).
- **Seam owner:** architect. **Implemented by:** the loop (test first).

---

## 1. Why the rejection is reversed

ADR-0017 §2.4 rejected shifting the dialog on two grounds. Both are answered, not ignored:

1. *"It inverts #22 — the site becomes the thing that yields."* The project dialog is not "the
   site": it is a modal overlay the visitor opened **while already in a conversation**. The page
   under it is behind a scrim either way. What yields here is one overlay's horizontal centring,
   to keep a second overlay the visitor is using reachable. #22's claim — *the site remains
   operable* — is strengthened: today the chat is the part that is dead.
2. *"Every project-dialog test acquires a hidden dependency on the assistant."* Avoided by
   construction: the dialog consumes **one generic page-level inset**
   (`--overlay-reserve-inline-end`, default `0px`) and knows nothing about the chat. With the
   property unset its geometry is byte-identical to today's. The chat is the inset's only writer.

## 2. DECISION 1 — `besideLayout`, a pure function in `js/chat-stage.js`

```js
// Measured once (ADR-0017 §2.4, browser): .project-dialog__panel content-bound width at a 16 px root
//   = 42rem (672) + padding-inline 1.35rem (21.6) + 2.75rem (44) + 2 × 1px border = 739.6
export const PROJECT_PANEL_MAX = 739.6
// Below this the panel is too narrow to read beside the chat (owner/RCA call).
export const PROJECT_PANEL_MIN = 560
// .project-dialog's `padding: 1rem`, per side.
export const PROJECT_DIALOG_PADDING = 16

/**
 * @param {{ viewportWidth: number, preferred: 'wide'|'compact' }} m
 * @returns {{ size: 'wide'|'compact', reserve: number, panelMax: number }}
 */
export function besideLayout ({ viewportWidth, preferred })
```

With `R(size) = dockedCardWidth({ viewportWidth, size }) + 2 · DOCK_GUTTER` and
`P(size) = min(PROJECT_PANEL_MAX, viewportWidth − R(size) − 2 · PROJECT_DIALOG_PADDING)`:

| condition | returns |
|---|---|
| `P(parseChatSize(preferred)) ≥ PROJECT_PANEL_MIN` | `{ size: preferred, reserve: R(preferred), panelMax: P(preferred) }` |
| else `P('compact') ≥ PROJECT_PANEL_MIN` | `{ size: 'compact', reserve: R('compact'), panelMax: P('compact') }` |
| else (no room) | `{ size: parseChatSize(preferred), reserve: 0, panelMax: min(PROJECT_PANEL_MAX, viewportWidth − 2 · PROJECT_DIALOG_PADDING) }` |

Non-finite / negative `viewportWidth` → the no-room row (an unmeasured viewport is not room, the
same rule `hasRoomBesideDialog` had). Thresholds with today's constants, DERIVED and checked
against `dockedCardWidth`:

| viewport | wide preferred | compact preferred |
|---|---|---|
| < 1016 | none | none |
| 1016 … 1351 | compact, R 424 (panel 560 → 739.6) | compact, R 424 |
| ≥ 1352 | wide, R 760 (panel 560 → 739.6 at ≥ 1532) | compact, R 424 |

The panel saturates at `PROJECT_PANEL_MAX` from 1196 px (compact) and 1532 px (wide).

`size` is the **effective** size only; it never overwrites the stored preference (the
`dockedSizeChrome` rule, ADR-0027 §3.3). **Why a constant and not a measurement:** the panel no
longer has a fixed width beside the chat — it shrinks into the space left — so there is nothing
stable to measure; the decision is a function of the viewport alone, which is what makes it
testable in `node --test`. ADR-0017 §2.4's warning (a future `html { font-size: clamp() }` moves the
rem-bound width) is answered by a **CSS source pin** (§7) that recomputes `PROJECT_PANEL_MAX` from
the panel rule, so changing the CSS without the constant fails the suite.

### 2.1 What it replaces

- **`hasRoomBesideDialog` is deleted** (with its rows in `test/chat-stage.test.mjs`), as ADR-0026
  deleted `micAttachPlan`: its centred-dialog geometry no longer describes any layout the site
  renders, and a pure function nothing should call is a seam a future edit quietly re-opens.
- **`dockedSizeChrome({ stage, viewportWidth, preferred, beside })`** — `besideDialogWidth:
  number|null` becomes `beside: boolean` (a project dialog is showing). When `beside`,
  `canGoWide = isWideAvailable(vw) && besideLayout({ viewportWidth: vw, preferred: 'wide' }).size
  === 'wide'`; otherwise unchanged. Its returned `size` therefore equals `besideLayout`'s.
- In `js/chat.js`: `besideDialogWidth` and the per-apply `getBoundingClientRect()` on the project
  panel are deleted. The chip handler's `roomBeside` becomes `besideLayout(...).reserve > 0`.

## 3. DECISION 2 — wiring: one writer, one inset

`applyChatSize` in `js/chat.js` stays the **single writer** of the chat's size chrome and becomes
the single writer of the reserve. It computes:

```js
const projectShowing = getSiteState().project != null
const layout = besideLayout({ viewportWidth: window.innerWidth, preferred: chatSize })
const reserved = chatStage === 'docked' && projectShowing && layout.reserve > 0
```

and applies, via one helper `applyOverlayReserve(reserved ? layout.reserve : 0)`:

| when `reserved` | when not |
|---|---|
| `document.documentElement.style.setProperty('--overlay-reserve-inline-end', `${reserve}px`)` | `removeProperty('--overlay-reserve-inline-end')` |
| `#chatDialog[data-chat-beside="true"]` (the existing z 1102 lift) | `data-chat-beside="false"` |
| a11y swap (§5) applied | a11y swap removed |

`data-chat-size` / `--chat-dock-width` come from `dockedSizeChrome({ …, beside: projectShowing })`
as today.

**When `applyChatSize` runs** — explicitly, because `dispatchStage` returns early when the stage is
unchanged (RCA finding: docked → `project-open` → docked applies nothing):

- on **every** `project` store change (open and close), in the `subscribeSiteState` callback,
  **after** `dispatchStage` — unconditionally, not only when the stage moved;
- on `open-beside` (the chip; already present after its `dispatchStage`);
- on every `applyStage` (open / restore / minimize / close — already present), which is how the
  chat opening or restoring over an already-showing project dialog reserves;
- on `resize` (already present) — re-decides `layout` from the viewport alone.

Clearing therefore follows from the predicate: project-close (`projectShowing` false), chat
minimize (stage `minimized`), chat close (stage `closed`), and a resize below 1016 px
(`reserve` 0) all write the not-reserved column.

## 4. DECISION 3 — the reducer: below the floor, `project-open` minimizes

`nextChatStage` splits `project-open` from `navigate` (they share a case today) and takes one new
ctx flag, `reserveRoom` (`besideLayout(...).reserve > 0`, computed by `dispatchStage` alongside
`wide`):

```
project-open:  closed    → closed
               minimized → minimized
               modal | docked → ctx.reserveRoom ? 'docked' : 'minimized'
```

A missing `reserveRoom` reads as **no room** (strict: an unmeasured layout must not leave a card
under the scrim). `project-close` is unchanged: `minimized → yielded` (`docked` on wide), at the
stored size — that is the return path. `navigate` keeps today's rows. `open-beside` keeps
`ctx.roomBeside ? 'docked' : 'modal'`; its caller now feeds `besideLayout(...).reserve > 0`, so a
chip below 1016 px still opens the modal (as today) and at ≥ 1016 px docks beside.

This is the ADR-0015 §4.3 cell change; like `contact-open → minimized`, it is a pure reducer row.

## 5. DECISION 4 — CSS: the dialog consumes the inset generically

`css/styles.css`:

```css
.project-dialog {
  padding-inline-end: calc(1rem + var(--overlay-reserve-inline-end, 0px));
}
.project-dialog__panel {
  /* rendered border-box width must not exceed besideLayout().panelMax */
  max-width: min(42rem, calc(100vw - 2rem - var(--overlay-reserve-inline-end, 0px) - <panel padding + border>));
}
```

The exact `max-width` expression is the implementer's; the contract is the journey assertion
`PROJECT_PANEL_MIN ≤ panel width ≤ panelMax` and *no overlap with the card*. The scrim
(`.project-dialog__backdrop`, `position: absolute; inset: 0`) is unaffected by padding and stays
**full-bleed** under the lifted card; a click on it still closes the dialog. Nothing under
`.project-dialog` mentions the chat.

## 6. DECISION 5 — accessibility and Escape while reserved

### 6.1 Modality swap (applied/removed by `applyOverlayReserve` only)

- `#projectDialog .project-dialog__panel` → `aria-modal="false"` (restored to `"true"` on clear):
  two dialogs are interactive, so neither may tell AT the rest of the page does not exist.
- `inert` on **every element child of `<body>` except `#projectDialog` and `#chatDialog`** (header,
  main, footer, the spaceman, the hidden contact/privacy dialogs, the tour card…). The swap marks
  what it set (`data-overlay-inert="true"`) and on clear removes `inert` **only** from those, never
  from an element something else made inert.
- DOM order already gives Tab order `#projectDialog` → `#chatDialog`. No focus is moved by the
  reserve itself; `projects.js` still focuses the dialog's close button on open.

### 6.2 Escape routed by focus (today one Escape in the composer closes the project AND minimizes
the chat, because both document-level handlers run)

- `bindEscapeClosesDialogWhenOpen(dialog, closeFn, { ignoreFocusWithin })` in
  `js/dialog-helpers.js` gains an optional selector; when `document.activeElement` is inside it,
  the handler returns without `preventDefault` or close. `js/projects.js` passes
  `'#chatDialog'`. Contact and privacy dialogs pass nothing — unchanged.
- `js/chat.js`'s keydown: for a non-modal stage, `dispatchStage('escape', 'visitor')` only when
  focus is inside `#chatDialog`. **Consequence, stated:** with the card docked and focus on the
  page, Escape no longer minimizes it (it is the page's key then); the minimize button and Escape
  from inside the card still do. The modal-stage row is unchanged.

## 7. Pins (test-writer)

`node --test`:

1. **`besideLayout` rows** (`test/chat-stage.test.mjs`), both preferences: 1015 → none
   (`reserve 0`); 1016 → compact, `reserve 424`, `panelMax 560`; 1195 → compact, `panelMax 739`;
   1196 → compact, `panelMax 739.6`; 1351 → wide preferred falls back to compact; 1352 → wide,
   `reserve 760`, `panelMax 560`; 1531 → wide, `panelMax 739`; 1532 → `panelMax 739.6`; junk
   viewport → no room; the stored preference is not an output (compact preferred never returns
   wide).
2. **`dockedSizeChrome` with `beside`**: wide preferred at 1280 beside → `size 'compact'`,
   toggle hidden; at 1440 beside → `'wide'`.
3. **Reducer rows**: `project-open` from `docked` with `reserveRoom: true` → `docked`; with
   `false` / missing → `minimized`; from `modal` likewise; `closed`/`minimized` absorbing;
   `project-close` from `minimized` → `docked` (wide); `navigate` rows unchanged.
4. **Wiring** (`test/chat-stage-wiring.test.mjs`): docked + project-open at a 1440 stub viewport
   → `--overlay-reserve-inline-end` on `documentElement` equals `besideLayout().reserve`,
   `data-chat-beside="true"`, **even though the stage did not change**; project-close → property
   removed, `data-chat-beside="false"`, size back to the preference; minimize and close clear it;
   chat opened/restored with a project showing reserves; resize 1440 → 1000 clears it; at 1000,
   docked + project-open → stage `minimized`, project-close → `docked` at the stored size; no
   `stopVoice` call on any of these (#20).
5. **a11y**: reserved → panel `aria-modal="false"`, every other body child `inert` (marked);
   cleared → `aria-modal="true"`, only marked elements un-inerted (a pre-inerted element stays).
6. **Escape routing**: focus in the chat composer + Escape with a project open and reserved →
   project close **not** called, chat → `minimized`; focus in the project dialog + Escape →
   project closes, chat stage unchanged; contact dialog Escape unchanged.
7. **Source pins**: `.project-dialog` padding reads `var(--overlay-reserve-inline-end`; the panel
   rule's `42rem` + padding + border at 16 px equals `PROJECT_PANEL_MAX`; nothing under
   `.project-dialog` selectors references `chat`; `hasRoomBesideDialog` no longer exported.

`npm run test:journeys` (`scripts/qa/chat-stage-journeys.mjs`), at 1280, 1440 and 1920 for each
stored size, both orders (chat-then-project, project-then-chat):

- `elementFromPoint` at the card's centre and composer → the chat; at the panel's centre → the
  panel; at the far-left scrim → the scrim, and a click there closes the project dialog;
- card and panel rectangles do not overlap; panel width within `[560, panelMax]`;
- Escape with focus in the composer leaves the project dialog open;
- at 1000 px, project-open minimizes the docked card and project-close restores it.

## 8. Consequences

- On every desktop ≥ 1016 px the conversation stays usable while a project is open; the project
  panel shifts left (and narrows to ≥ 560 px) instead of being centred.
- Between 768 and 1015 px a docked chat yields to a pill when a project opens (it was a blurred,
  unreachable card).
- `hasRoomBesideDialog`, `besideDialogWidth` and the live panel measurement are removed; the
  ADR-0027 §9 lift rule is restated as "lifted exactly while reserved".
- Escape on a docked card with focus outside it is no longer a minimize.
- No store field, wire, backend or voice change.

---

## Addendum (2026-10-24, orchestrator override — PO N-P3)

- A project **chip** ("talk about this") below 1016 px keeps today's behaviour: `open-beside`
  with `roomBeside: false` → `modal`, over the dialog (z 1105). Unchanged from §4.
- Only a project dialog opened **from the page** (`project-open`, §4), or **the chat opening or
  restoring while a project dialog shows**, tucks the chat into the minimized pill below 1016 px.
  The second clause is one reducer row family: on a wide viewport `open-text` / `open-voice` /
  `restore` read a second injected flag, `ctx.projectShowing`, and land `minimized` when it is
  true and `ctx.reserveRoom` is not (else `docked`, as today). Narrow (< 768) is unchanged (modal).
- Where the PO geometry (centred dialog area, 552 px minimum) and this ADR differ, **this ADR
  wins** (`besideLayout`, `PROJECT_PANEL_MIN` 560, the panel shifted by the inset).

### Addendum 2 (2026-10-24, coordinator — found by the journeys: the chat must never become unreachable)

- **Escape inside the chat while reserved is a no-op** for the chat and for the dialog (amends
  §6.2's "Escape from inside the card still minimizes"): it neither minimizes the chat nor closes
  the project dialog — the dialog's × and the grey area close it. With no dialog showing,
  Escape in the card still minimizes.
- **The minimise button still minimises, and the pill keeps the column** (amends §3's "chat
  minimize clears"): `reserved = (docked | minimized) && projectShowing && reserve > 0`. The pill
  sits in the empty reserved column, is lifted above the scrim
  (`#chatDialog[data-chat-stage='minimized'][data-chat-beside='true']`, z 1102) and is never
  inert, so a click on it restores the docked card, reserved again. `#agentActiveChip` lives in
  the inert header under the scrim and is NOT lifted — the pill itself is the restore control.
- **A resize below 1016 with a dialog open tucks a docked card** (amends §3's "a resize below
  1016 clears"): the resize handler re-runs `project-open` for a docked card (never a modal),
  so it lands `minimized`; widening never promotes the pill (`viewport-wide` rule); closing the
  dialog returns it `docked` at the stored size (`project-close`).
- Below 1016 the tucked pill is not lifted (no reserved column to sit in; it would cover the
  panel). Per N-P3 a restore there stays a pill; the chip is the way to talk (modal).
