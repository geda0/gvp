# ADR-0027 — The docked card is the main window: a WIDE and a COMPACT size, an orthogonal `chatSize`, and a width that always leaves the site usable

- **Status:** **Accepted (contract only — no code written by this ADR).** The seams below are what
  the test-writer builds failing tests against.
- **Date:** 2026-10-24
- **Source:** owner request (2026-10-24): make the docked card the main chat window style, add a
  bigger WIDE size anchored where the compact card sits, with a toggle usable at any time including
  right at first open; respect screen size; the site must stay usable at all times. **Owner
  decisions:** default on first open = **WIDE**; the wide window **floats** over the page (no
  backdrop, no reflow, may cover part of the content).
- **Supersedes:** ADR-0015 **§4.3** rows `open-text` / `open-voice` and `restore` in the **wide**
  column only (`modal` → `docked`). Every other cell of §4.3 and the whole §4.4 table are unchanged.
- **Amends:** ADR-0017 **§2.4** — the `cardWidth` fed to `hasRoomBesideDialog` comes from
  `dockedCardWidth` (§3 below) instead of the literal `DOCKED_CARD_WIDTH = 384`; the predicate
  itself is unchanged. ADR-0017 **§2.6** — `stageChrome`'s `opts` gains `focusInside` (§5).
- **New invariant:** **#27** in `docs/tdd/project-invariants.md`.
- **Seam owner:** architect. **Implemented by:** the loop (test first). Acceptance criteria are the
  product-owner's (`.claude/state/design-notes.md`), not this file's.

---

## 1. Context

Today every visitor-initiated open lands in `modal` (`js/chat-stage.js` `open-text` / `open-voice`
/ `restore` → `'modal'`; `js/chat.js` `openPanel` even bypasses the reducer with a literal
`applyStage('modal', 'visitor')`, which `test/chat-stage-wiring.test.mjs:478` records as
`BYPASSED`). The modal is a 672 px centred panel over a click-eating backdrop with scroll lock. The
docked card (`css/chat.css` `[data-chat-stage='docked']`, 384 px, bottom-right, z 1085, no backdrop)
is only reached by **yielding**. The owner wants the docked card to be what "open" means, plus a
wider variant of it.

Measured / derived geometry used below (all from shipped CSS and ADR-0017 §2.4):

| thing | value | source |
|---|---|---|
| compact docked card | `min(24rem, 100vw − 2rem)` = **384 px** at ≥ 416 px | `css/chat.css` docked block; browser-measured 384 (ADR-0017 §2.4) |
| docked shell padding | `clamp(0.75rem, 2vw, 1.25rem)` = 20 px at ≥ 1000 px | `css/chat.css` docked/minimized shell |
| gutter used by `hasRoomBesideDialog` | **20 px** | `js/chat.js` `DOCK_GUTTER` |
| modal panel | `min(42rem, 100vw − 2rem)` = 672 px | `css/chat.css` `.chat-dialog__panel` |
| project dialog panel | 739.59 px (content-bound above ~704 px) | ADR-0017 §2.4 |
| the reducer's `ctx.wide` | `(min-width: 768px)` | `js/chat.js` `isWideViewport` |

---

## 2. Decision — size is ORTHOGONAL to stage, chat-local, and not a reducer input

### 2.1 Not a new stage

`'docked-wide'` as a fifth `ChatStage` is **rejected**. It would double every docked row of the
§4.3 table and the §4.4 a11y table (whose cells would be identical — a wide card has exactly the
docked chrome), add a branch to every `stage === 'docked'` test in `js/chat.js` and every
`[data-chat-stage='docked']` rule in `css/chat.css`, and force a decision on transitions that have
no meaning (does `navigate` from `docked-wide` stay wide? — of course, so the table would just be
copied). Size changes **geometry**, never **chrome**; stage is chrome.

### 2.2 Not a site-state field

`chatSize` is **chat-local** in `js/chat.js`, not a sixth field in `js/site-state.js`. No other
module reads or writes it, it never reaches the model's `siteState` wire (ADR-0015 §6 — a
presentation preference is not context the agent needs, and adding it would make every toggle a
live-note candidate that §7's dedupe then has to suppress), and ADR-0015 §3.1 fixes the store at
five fields. If a second module ever needs it, that is the moment to add a narrow writer with an
`origin`; not before.

### 2.3 The reducer stays voice-blind AND size-blind

`nextChatStage(stage, event, ctx)` gains **no** size input and **no** new event. `CHAT_STAGE_EVENTS`
is unchanged (so `test/chat-stage-wiring.test.mjs`'s "every event reachable" test needs no new
caller). Invariant #20's constructive half — `voiceActive` appears nowhere in the reducer — holds
unchanged, and the size functions in §3 take no voice input either.

### 2.4 The two state cells that change (the superseded §4.3 rows)

`W = ctx.wide ? 'docked' : 'modal'` (note: **not** ADR-0015's yield `W`, which falls back to
`minimized`; an OPEN on a narrow viewport still takes the screen).

| event ↓ / from → | `closed` | `modal` | `docked` | `minimized` |
|---|---|---|---|---|
| `open-text` / `open-voice` | **`W`** | **`W`** ¹ | **`W`** | **`W`** |
| `restore` | `closed` | **`W`** ¹ | `docked` (wide) / `modal` (narrow) | **`W`** |

1. From `modal` on a wide viewport (only reachable via `open-beside` with no room, ADR-0017 §2.5,
   or a viewport that widened under a modal) a re-open **docks**. Re-opening is a visitor act, so
   this is not the "width never changes a focused panel" rule (ADR-0015 note 9) being broken: the
   viewport rows are untouched — `viewport-wide` from `modal` is still `modal`.

So **`modal` survives for exactly two cases**: (a) every open on a viewport `< 768 px` (phones and
narrow tablets, where the ≤ 640 px rule makes it full-screen as today), and (b) `open-beside` when
there is no room beside the project dialog. Everything else that opens lands `docked`.

**Breakpoint rule, from geometry, not taste.** Docking is offered iff `ctx.wide` (≥ 768 px), the
shipped breakpoint — **kept, not re-derived to a second number**, because the yield rows already
use it and two breakpoints for "can a card sit here" is a drift generator. It is *consistent* with
§3's usability floor: a compact card needs `384 + 2·16 + DOCK_MIN_UNCOVERED (320) = 736 px`; 768
clears it with 32 px slack. A test pins that relation (§8), so a future change to either number
that breaks it goes red.

`escape`, `minimize`, `navigate`, `project-*`, `contact-*`, `close`, `viewport-*` and
`open-beside` rows: **unchanged.** In particular Escape from `docked` still yields to `minimized`
(non-destructive) — which, now that docked is the main window, means **Escape no longer closes the
chat on a wide viewport**; it minimises it. Recorded as a consequence, not an accident (§9).

### 2.5 `openPanel` goes THROUGH the reducer

`js/chat.js` `openPanel` must stop applying a literal `'modal'` (both the `isOpen()` promote branch
and the cold-open branch). It applies
`nextChatStage(chatStage, wantVoice ? 'open-voice' : 'open-text', { wide: isWideViewport() })`
with `origin: 'visitor'`. The `BYPASSED` map in `test/chat-stage-wiring.test.mjs` loses
`open-text` / `open-voice` (they become reducer-routed; `close` stays bypassed via `closePanel`).
The seed-rect open animation targets whatever panel rect the resulting stage produces and keeps its
`prefersReducedMotion()` guard.

---

## 3. Decision — geometry is a pure function in `js/chat-stage.js`

All new exports live in `js/chat-stage.js` beside `hasRoomBesideDialog` (same seam, no new file).
All take plain numbers; none reads `window`.

```js
export const CHAT_SIZES            = Object.freeze(['wide', 'compact'])
export const DEFAULT_CHAT_SIZE     = 'wide'     // owner decision: first open is WIDE
export const DOCK_COMPACT_WIDTH    = 384        // == min(24rem, …) at 16px root; browser-measured
export const DOCK_EDGE_INSET       = 16         // the `- 2rem` in min(24rem, 100vw - 2rem), per side
export const DOCK_GUTTER           = 20         // moved here from js/chat.js; same value
export const DOCK_WIDE_MAX_WIDTH   = 720
export const DOCK_WIDE_MIN_WIDTH   = 480        // below this "wide" is not meaningfully wider
export const DOCK_MIN_UNCOVERED    = 320        // px of page the card must ALWAYS leave beside it

export function parseChatSize (raw)                       // -> 'wide' | 'compact'
export function dockedCardWidth ({ viewportWidth, size }) // -> number (px)
export function isWideAvailable (viewportWidth)           // -> boolean
export function dockedSizeChrome ({ stage, viewportWidth, preferred, besideDialogWidth })
  // -> { size, width, toggleHidden, togglePressed }
```

### 3.1 `dockedCardWidth`

- `compact` → `max(0, min(DOCK_COMPACT_WIDTH, viewportWidth − 2·DOCK_EDGE_INSET))` — byte-identical
  to the shipped CSS, so the compact card does not move by a pixel.
- `wide` → `min(DOCK_WIDE_MAX_WIDTH, viewportWidth − 2·DOCK_GUTTER − DOCK_MIN_UNCOVERED)`, and if
  that is `< DOCK_WIDE_MIN_WIDTH` it returns the **compact** width (fallback, never a sliver).
- Non-finite / negative `viewportWidth` → `0`. The caller treats `0` as "remove the custom
  property", so the CSS fallback (the shipped compact rule) applies. An unknown `size` is treated
  as `compact`.

Derived numbers the tests pin: wide is **available from 840 px** (`480 + 40 + 320`), reaches the
**720 px cap at 1080 px**; at 1024 px wide = 664; at 1280 / 1512 / 1920 = 720. Compact is 384 at
every docked width.

`isWideAvailable(vw)` ≡ `vw` finite and `min(720, vw − 360) ≥ 480`, i.e. `vw ≥ 840`.

**Why a usability floor (`DOCK_MIN_UNCOVERED`) and not the owner's example `min(720, vw − 40)`.**
That formula gives a 720 px card at 768 px — 8 px of page left. "Floats, may cover part of the
content" is the owner's ruling; "the site must stay usable at all times" is the owner's constraint,
and it has to be a number to be testable. 320 px is the narrowest layout the site already supports
(phone width), so the uncovered strip is always a usable column of the site. This is the content of
invariant #27.

### 3.2 `hasRoomBesideDialog` with the wide width

Unchanged predicate. The `open-beside` caller (`js/chat.js` project-chip handler) keeps deciding
the **stage** with the compact width — `cardWidth: dockedCardWidth({ viewportWidth, size: 'compact' })`
— so `docked` vs `modal` beside a project dialog is exactly today's rule. The **size** beside a
dialog is decided by `dockedSizeChrome` with `besideDialogWidth` = the measured project panel
width: wide only if `hasRoomBesideDialog({ …, cardWidth: dockedCardWidth({ size: 'wide' }) })`,
otherwise compact. Three outcomes, in order: **wide beside → compact beside → modal**. Never
minimised (ADR-0017 §2.5's reasoning stands).

### 3.3 `dockedSizeChrome` — the size contract as data

```
canGoWide = isWideAvailable(viewportWidth)
         && (besideDialogWidth == null
             || hasRoomBesideDialog({ viewportWidth, dialogWidth: besideDialogWidth,
                                      cardWidth: dockedCardWidth({ viewportWidth, size: 'wide' }),
                                      gutter: DOCK_GUTTER }))
size          = parseChatSize(preferred) === 'wide' && canGoWide ? 'wide' : 'compact'
width         = dockedCardWidth({ viewportWidth, size })
toggleHidden  = stage !== 'docked' || !canGoWide
togglePressed = size === 'wide' ? 'true' : 'false'
```

- `besideDialogWidth`: **`null` means "not beside any dialog"**; a number (including `0`) means
  "beside a dialog, this is its measured width", and `0` therefore reads as **no room** (the same
  "an unmeasured rect is not room" rule as `hasRoomBesideDialog`). Do not collapse the two into `0`.
- **The effective size never overwrites the preference.** A fallback (narrow viewport, project
  dialog) renders compact while `preferred` stays `'wide'`; widening or closing the dialog brings
  wide back with no visitor act. Only the toggle writes the preference.
- The toggle is **hidden, not disabled,** when wide cannot render: a control that does nothing is
  noise to a screen reader, and showing it beside a project dialog would invite a wide card that
  sits under `.project-dialog`'s backdrop (z 1100 > 1085, ADR-0017 §2.1).

---

## 4. Decision — DOM / CSS contract

On `#chatDialog`, written by one function in `js/chat.js`, `applyChatSize()`, from
`dockedSizeChrome(...)` only:

| hook | value | notes |
|---|---|---|
| `data-chat-size` | `'wide' \| 'compact'` (the **effective** size) | always set (also when not docked) so CSS never sees it missing; CSS reads it only under `[data-chat-stage='docked']` |
| `style --chat-dock-width` | `${width}px` | omitted (removed) when `width` is `0` |

`applyChatSize()` runs on: every `applyStage`, the toggle, `window` `resize` (passive), the store's
`project` → `null` change (clears `besideDialogWidth`), the project-chip handler (sets it), and
closing (clears it).

CSS (`css/chat.css`, docked block):

```css
#chatDialog[data-chat-stage='docked'] .chat-dialog__panel {
    width:     var(--chat-dock-width, min(24rem, calc(100vw - 2rem)));
    max-width: var(--chat-dock-width, min(24rem, calc(100vw - 2rem)));
}
#chatDialog[data-chat-stage='docked'][data-chat-size='wide'] .chat-dialog__panel {
    height: min(72vh, 44rem);  max-height: min(72vh, 44rem);
}
@media (prefers-reduced-motion: no-preference) {
    #chatDialog[data-chat-stage='docked'] .chat-dialog__panel {
        transition: width 200ms ease, max-width 200ms ease, height 200ms ease, max-height 200ms ease;
    }
}
```

- **The width has ONE source of truth: `dockedCardWidth`.** CSS does not restate 720/320; the
  `var()` fallback is the shipped compact rule, so JS failing to run degrades to today's card. A
  pure-CSS `clamp()` was rejected because `hasRoomBesideDialog` needs the same number in JS — two
  copies of one formula is the drift ADR-0017 §2.4 already warned about.
- **Anchoring unchanged:** the shell's `align-items/justify-content: flex-end` keeps both sizes in
  the bottom-right corner; wide grows **leftward and upward** from the same corner. No reflow of
  page content, no backdrop, z-index stays 1085 (`chat-stage-layering.test.mjs` unchanged).
- **Reduced motion:** the transition is declared **only inside `no-preference`**, so the existing
  `@media (prefers-reduced-motion: reduce) { #chatDialog[data-chat-stage] .chat-dialog__panel { transition: none } }`
  cannot be out-specified by it. Invariant #22's "stage transitions honour reduced motion" extends
  to size transitions by construction.
- `.tour-card` (z 1150, bottom-centre) is above the docked card at every size; a wide card never
  hides the tour. Accepted as-is.

### 4.1 The toggle

Markup in `index.html`, inside `.chat-dialog__header-actions`, **before** `.chat-dialog__minimize`:

```html
<button type="button" class="chat-dialog__size" data-chat-size-toggle
        aria-pressed="true" aria-label="Wide chat window" hidden></button>
```

- **Role: a toggle button — `aria-pressed`, not `aria-expanded`.** `aria-expanded` means "controls
  the visibility of other content"; this changes the size of the region it lives in. `aria-pressed`
  = `'true'` when the effective size is wide.
- **The accessible name is FIXED** ("Wide chat window") and never swaps with state — a pressed
  button whose label also flips reads as a double negative. The visible glyph may swap
  (expand/contract icon, `aria-hidden` on the glyph).
- Visible only in `docked` (CSS: `display: none` by default, `inline-flex` under
  `[data-chat-stage='docked']`, exactly like `.chat-dialog__minimize`) **and** not `[hidden]`
  (`.chat-dialog__size[hidden] { display: none }` must win). `hidden` is driven by `toggleHidden`.
- **Click:** flips the preference (`'wide' ⇄ 'compact'`), persists it (§6), calls
  `applyChatSize()`, `event.stopPropagation()` (same as minimise, so the dialog's click handler
  does not see it). It **does not** call `dispatchStage`, `focus()`, or anything voice. Focus
  therefore stays on the toggle (the button is not re-rendered or moved in the DOM; only its
  attributes change).
- Available from the **first frame of the first open**: the first open lands `docked` (wide
  viewport) with `applyChatSize()` run in the same `applyStage`, so the toggle is visible and
  correct before any transcript exists.
- Analytics: `chat_size_toggle` with exactly `{ to: 'wide' | 'compact' }` — a closed enum, no free
  text (ADR-0020 bounded sinks). Registering it in the admin usage tab is not part of this ADR.

---

## 5. Decision — a11y chrome stays data; one new optional input for focus

`stageChrome('docked')` is **unchanged**: `backdropHidden: true`, `scrollLock: false`,
`ariaModal: 'false'`, `pointerEventsOnShell: 'none'`, no focus trap. Size does not appear in
`stageChrome` at all — a wide card is non-modal for the same reasons a compact one is (#22).

Two focus cells now matter far more, because docked is the main window:

1. **Entering `docked` by request focuses the composer** — already ADR-0017 §2.6's
   `{ requested: true }`. The wiring rule becomes exact: `applyStage` passes
   `requested: origin === 'visitor'`. Visitor events that land `docked` are `open-*`, `restore` and
   `open-beside` — all requests; yields to `docked` (`project-close`, `contact-close`) are
   `'system'` and move nothing.
2. **NEW — leaving a focused card for the pill.** Escape or the minimise button on the main window
   now hides the composer that holds focus, dropping focus to `<body>`. `stageChrome` gains
   `opts.focusInside` (the glue reports whether `document.activeElement` is inside `.chat-dialog__panel`
   *before* applying):

   `stageChrome('minimized', { requested: true, focusInside: true }).moveFocus === 'resume-chip'`

   → focus `#agentActiveChip` (the "Assistant active" chip, whose click is `restore`). Every other
   combination keeps today's value (`'none'`); in particular a **system** minimise (`contact-open`)
   never moves focus — the contact dialog is taking it. `'resume-chip'` joins the `moveFocus`
   vocabulary (`'restore' | 'composer' | 'none' | 'resume-chip'`). Default arguments reproduce
   today's table byte for byte.

---

## 6. Decision — persistence

- **`localStorage`**, key **`CHAT_SIZE_STORAGE_KEY = 'gvp-chat-size'`** (house convention:
  `gvp-chat-language` is the precedent for a visitor *preference*; `sessionStorage`'s
  `gvp-chat-session-id` is for *identity* that must not outlive the tab). A visitor who chose
  compact should get compact next visit; a first-time visitor gets `DEFAULT_CHAT_SIZE` (`'wide'`).
- Read **once** at `initChat`: `parseChatSize(localStorage.getItem(CHAT_SIZE_STORAGE_KEY))` inside
  `try/catch`; any throw or any value not in `CHAT_SIZES` → `'wide'`.
- Written **only by the toggle**, inside `try/catch` (blocked storage → the choice lives for the
  page). Never written by a fallback, a resize, or a stage change.

---

## 7. Transitions — what each event does to size

| event | stage effect | size effect |
|---|---|---|
| first open, wide viewport | `closed → docked` | effective = `dockedSizeChrome` of the stored pref (`'wide'` if none) |
| first open, `< 768` | `closed → modal` | none rendered (toggle hidden; pref untouched) |
| toggle | none | pref flips, persisted, applied; focus stays on toggle |
| `minimize` / `escape` → `minimized` | as today | pref untouched; `restore` / re-open come back **at the last chosen size** |
| `navigate`, `project-open` (from docked) | idempotent `docked` | none (no measurement on a site event) |
| `project-close` | as today | `besideDialogWidth = null` → re-resolve (a wide pref returns to wide) |
| `contact-open` / `-close` | as today | none |
| `open-beside` | docked / modal as today (compact-width predicate) | `besideDialogWidth` = measured panel width → wide only if wide fits beside |
| `resize` across 840 px | none | effective flips wide⇄compact; toggle hides below 840; pref untouched |
| `viewport-narrow` (< 768) | `docked → minimized` (unchanged) | n/a while minimized |
| `viewport-wide` | unchanged (`minimized` stays; `modal` stays) | re-resolve on the next docked apply |
| `close` | as today | `besideDialogWidth = null`; pref kept |

Voice: no row touches voice; the toggle joins the set of visitor acts that must leave a live
session running (invariant #20's pin list).

---

## 8. What the tests pin (names to use)

- `test/chat-stage.test.mjs`: the `TABLE` rows for `open-text` / `open-voice` / `restore` move to
  `docked` in the wide column (narrow column unchanged); `parseChatSize` (`null`, `''`, `'WIDE'`,
  `'huge'` → `'wide'`; `'compact'` → `'compact'`); `dockedCardWidth` at 767, 768, 839, 840, 1024,
  1080, 1280, 1920 and at `NaN` / negative; `isWideAvailable` at 839/840; the relation
  `768 − dockedCardWidth({ viewportWidth: 768, size: 'compact' }) − 2·DOCK_EDGE_INSET ≥ DOCK_MIN_UNCOVERED`;
  for every vw in a sweep 768…2560, `vw − dockedCardWidth({vw, size}) − 2·DOCK_GUTTER ≥ DOCK_MIN_UNCOVERED`
  for both sizes (#27); `dockedSizeChrome` for null vs `0` vs measured `besideDialogWidth`
  (dialog 739.59: at 1280 and at 1920 → compact, since `(1920 − 739.59)/2 = 590.2 < 720 + 20`; the
  crossover is `vw ≥ 739.59 + 2·(720 + 20) = 2219.59` — pin 2219 → compact, 2220 → wide),
  `toggleHidden` per stage; `stageChrome('minimized', { requested: true, focusInside: true })`.
- `test/chat-stage-a11y.test.mjs`: the toggle's `aria-pressed` tracks effective size, its
  `aria-label` never changes, focus remains on it after a click, and `docked` at both sizes has
  `aria-modal="false"` with the backdrop hidden.
- `test/chat-stage-wiring.test.mjs`: `openPanel` on a wide viewport lands `docked` with
  `data-chat-size="wide"` and `--chat-dock-width: 720px` (at ≥ 1080) with **no** prior storage;
  `BYPASSED` drops `open-*`; the toggle makes no store write and no `stopVoice` call; a stored
  `'compact'` is honoured on first open; a throwing `localStorage` still opens wide.
- CSS source assertion: the docked width rule reads `var(--chat-dock-width` and the size transition
  is declared only inside `prefers-reduced-motion: no-preference`.
- Browser journey (confirming, once): at 1280×800 open → wide card, a click at `x = 100` reaches
  site content; toggle → compact; reload → compact.

---

## 9. Consequences

- **The default experience changes on desktop:** opening the chat no longer dims or locks the page.
  `modal` remains for phones and the no-room project case.
- **Escape on a wide viewport minimises instead of closing.** Closing is the X. Deliberate: the
  docked card is non-modal and Escape on it was already "yield" (ADR-0015 §4.3); keeping that row
  avoids a keystroke that discards the transcript of the now-default window.
- `DOCK_GUTTER` and the 384 literal move from `js/chat.js` into `js/chat-stage.js` exports; the
  chip handler imports them.
- **Drift filed, not fixed (for the loop to verify in a browser):** ADR-0017 §2.5 docks the card
  *beside* a project dialog, but the yielded card sits at z 1085 under `.project-dialog`'s
  `inset: 0` backdrop (z 1100, 72 % alpha + blur, ADR-0017 §2.2). If a beside-docked card is in
  fact covered and untappable, that is pre-existing and independent of size; this ADR's "wide only
  if it fits beside" rule does not make it worse.
  **Resolved by the loop (2026-10-24):** reproduced in the journey (at 1920×1080
  `elementFromPoint` over the beside card returned the project dialog). `applyChatSize` sets
  `data-chat-beside="true"` and `css/chat.css` lifts that card to z 1102 (above the 1100 scrim,
  below the 1105 modal and the 1150 tour) — **only while** `hasRoomBesideDialog` holds for the
  compact card against the project panel **re-measured live** on every apply (resize, restore,
  toggle). A beside card that stops fitting (narrower window) loses the mark and drops back under
  the scrim instead of covering the dialog's own panel (tdd-critic, measured 54–370 px overlap
  when the lift was remembered). A plain yield to a dialog is never marked.
- No backend, wire, store or voice change. ADR-0015's store stays at five fields.
