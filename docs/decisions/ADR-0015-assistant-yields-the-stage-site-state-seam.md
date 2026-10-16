# ADR-0015 — The assistant yields the stage: one site-state store, a stage reducer, and a bounded `siteState` wire

- Status: Accepted
- Date: 2026-10-13
- Seam owner: architect
- Cited by: **M2** (`docs/plan-2026-09-port.md` § *M2 — Assistant yields the stage + site awareness*).
  M4 (*Assistant everywhere*) extends §4 and §5 additively; M4 does **not** need a new ADR for
  adding wire fields to the sub-model defined in §6.
- Extends: ADR-0007 (browser-direct voice — the session this ADR stops tearing down),
  ADR-0020 (public unauthenticated sinks are bounded at the sink — §6 applies its rule to a new field).
- **Depends on an unresolved decision:** ADR-0010 and ADR-0011 are *Accepted and unimplemented*,
  and they own the section vocabulary this ADR navigates against. §2 is the blocker; §5.1 is the
  decision that makes M2 buildable without pre-empting them.
- Supersedes: nothing. §9 **refutes three claims** in `docs/plan-2026-09-port.md` § M2 and
  **one** in `.claude/state/backlog.md` Track C. Refutations are recorded, not deleted.

---

## 0. How to read this ADR

Facts labelled **MEASURED** were read out of the repo at `agent` / `a6e27e2` on 2026-10-13 and are
cited to `file:line`. Facts labelled **DERIVED** follow from a MEASURED fact by argument, not by
observation. Facts labelled **UNVERIFIED** come from the 2026-08 transcript via
`docs/plan-2026-09-port.md` and **could not be checked in this repo** — they are carried as claims,
not as state. Line numbers drift; the cited symbol is the anchor.

Suite baseline, MEASURED by running both: app `node --test` **219 tests / 218 pass / 1 skipped**;
chat `pytest` **147 passed**. (The plan's "baseline at plan time" of 203/202 and 114 is stale —
M0 and M1 have landed since.)

---

## 1. Context

M2's user-visible claim is one sentence: **the site stays operable while the assistant is on
screen, and the assistant's own actions no longer destroy the conversation that promised them.**
Everything in this ADR exists to make that sentence testable from two sides independently.

The plan proposes four new seams — `js/site-state.js`, `js/chat-dock.js`, a `siteState` field on
two public HTTP routes, and a live-session context note. ~16 slices across `app` and `chat` are
about to be cut against them. The plan was written from a transcript of a session run against a
**different snapshot** of this repo and has not been checked against the code since; M0 and M1
landed in between. So §9 verifies the plan's root cause before §3–§7 enshrine anything.

---

## 2. BLOCKER — the section vocabulary is already owned, by two accepted ADRs that never shipped

> **RESOLVED 2026-10-15 — this blocker is cleared; read the rest of §2 as the analysis that
> produced the decision, not as an open question.**
>
> Both ADRs were amended rather than left contradicting shipped code:
> - **ADR-0011 → `Reverted`**, and its `Supersedes:` line removed. That line was the live
>   hazard: it claimed authority over `test/labs-restructure.test.mjs`, so for ~4 months an
>   `Accepted` ADR said a GREEN test pinned obsolete behaviour. Anyone "fixing" that test to
>   match the document would have broken shipped navigation. `f454481` states the revert
>   outright: *"Portfolio+Labs kept; IA-merge ADR-0011 reverted"*.
> - **ADR-0010 → §1 amended.** Its enum is explicitly prefixed *"After the Portfolio+Labs
>   merge"*, so it was always conditional on ADR-0011 and is void. Its **seam** survives and is
>   worth keeping (declarations narrow over time, the FE handler stays tolerant of legacy
>   input); §2 — navigation parity on the text path — has shipped.
>
> The shipped vocabulary is therefore `home | portfolio | labs` (legacy `playground` → `labs`),
> verified in `js/section-names.js`, with `test/labs-restructure.test.mjs` green at 4/4. **M2
> does not introduce a third vocabulary** — §2.1 below stands: the registry becomes data.
>
> Note also that `.claude/tdd.config`'s `SECURITY_GLOB` has since been **widened** beyond what
> §6.7 measured — it now also covers the chat templates and `secret_resolver.py` (`27226ea`).
> §6.7's clearance scope is unchanged for the files it names.

**This is the finding that most changes M2's shape, and it is not in the plan.**

MEASURED:

- **ADR-0010** (`Status: Accepted`, 2026-06-17) fixes the `navigate_to_section` enum at
  `section ∈ { 'home', 'work', 'experience', 'contact' }` (ADR-0010 §1, line 40) and adds a second
  tool, `show_around`.
- **ADR-0011** (`Status: Accepted`, 2026-06-17) declares the IA as `home · work · experience ·
  contact`, renames `#portfolio` → `#work`, folds `#labs` into `#work`, and states in its own
  header: *"Supersedes: the Portfolio/Labs split established in `test/labs-restructure.test.mjs`"*.
- **Neither has shipped.** `js/navigation.js` routes `#portfolio` / `#labs` / base-URL home;
  `js/section-names.js:5-9` resolves `home|portfolio|labs`; `grep -rn show_around js/
  docker/chat/app/ data/` returns **nothing**.
- `test/labs-restructure.test.mjs:14-16,31-35` still asserts `normalizeSection('labs') === 'labs'`,
  `#labsContent`, `#labsNav` — i.e. it still pins the split ADR-0011 says it supersedes — and that
  test file is **green** inside the 219.
- `.claude/state/backlog.md:9` still marks the Work-showcase milestone **ACTIVE**, with Track C
  (items 5–7) unticked.

So there are two live vocabularies (shipped `portfolio|labs`, accepted-but-unbuilt
`work|experience`) and an accepted ADR contradicted by a green test. If M2 writes a third
normaliser with its own opinion, whichever of M2 / Work-showcase lands second reworks the first —
exactly the conflict the plan flagged under *"Open for the navigator"* and left undecided.

**Decision 2.1 — M2 does not own the section vocabulary, and does not implement ADR-0011's rename.**

The vocabulary becomes **data in one module**, and every consumer is a table lookup:

```js
// js/section-names.js  (extended; it is already the single resolver)
export const SECTION_IDS = ['home', 'portfolio', 'labs']       // the shipped registry
export const SECTION_ALIASES = { playground: 'labs' }          // legacy + future renames land HERE
export function resolveNavTarget(raw)   // → { id, hash } | { error: 'unknown_section', received }
```

- `resolveNavTarget` normalises before matching: `String(raw).trim().toLowerCase()`, then
  `SECTION_ALIASES`, then `SECTION_IDS`. Case and whitespace stop being failure modes (§9.2).
- `siteState.section` is contractually **"a member of `SECTION_IDS`"**, never a hard-coded union.
  The stage reducer, the store, the wire sub-model and the server's prompt line are all
  vocabulary-agnostic.
- ADR-0011's rename therefore becomes a **data edit** to `SECTION_IDS` + `SECTION_ALIASES` plus the
  DOM/route work it already owns — it does not touch anything M2 builds.
- **Consequence:** M2 and the Work-showcase milestone become order-independent. That is the point.
- **Consequence:** the two tool declarations (§9.3) must be generated from, or asserted against,
  the same registry. A test that the live enum and the text enum are equal and are a subset of
  `SECTION_IDS ∪ keys(SECTION_ALIASES)` is cheaper than the drift it prevents, and that drift is
  live today.

**Still open for the navigator (one decision, zero slices):** whether ADR-0010/0011 stay Accepted
and get built by the Work-showcase milestone, or get superseded. Decision 2.1 makes M2 safe under
either answer, so M2 is **not** gated on it. But an ADR that is Accepted and contradicted by a
green test should not stay that way quietly.

---

## 3. Decision — `js/site-state.js`, the observable store

### 3.1 Shape

Flat, JSON-serialisable, exactly five fields. One nested object (`project`) and nothing deeper.

```js
{
  section:     'home',    // string, a member of SECTION_IDS
  project:     null,      // null | { id: string, title: string }
  contactOpen: false,     // boolean
  chatStage:   'closed',  // 'closed' | 'modal' | 'docked' | 'minimized'  (see §4)
  voiceActive: false      // boolean
}
```

### 3.2 Who may write each field — enforced by the API, not by a comment

There is **no generic `set(patch)`**. The module exports one narrow writer per field, and the
writer *is* the permission:

| field | writer | writing module | readers |
|---|---|---|---|
| `section` | `setSection(id, opts)` | `js/navigation.js` (`applySection`) | all |
| `project` | `setProject(p \| null, opts)` | `js/projects.js` | all |
| `contactOpen` | `setContactOpen(bool, opts)` | `js/contact.js` | all |
| `chatStage` | `setChatStage(stage, opts)` | `js/chat.js` only | all |
| `voiceActive` | `setVoiceActive(bool, opts)` | `js/chat.js` only (bridged from `chat-live.js` via the existing `patchLiveUi`, `js/chat.js:786`) | all |

Readers get `getSiteState()` — a **frozen** snapshot (`Object.freeze`, and a frozen copy of
`project`) so a reader cannot mutate the store by accident. A test asserts the freeze: a reader
that writes must throw in strict mode, not silently succeed.

`js/app.js` writes **nothing**. It is the wiring module; today it is also the module that calls
`collapseChatDialog()` (§9.1), and that call is deleted.

### 3.3 `origin` is mandatory on every write — and it is load-bearing

```js
setSection('portfolio', { origin: 'visitor' })   // opts.origin: 'visitor' | 'agent' | 'system'
```

Default `'visitor'`. `'agent'` means *a tool call the model made caused this*. `'system'` is for
boot (`navigateByHash()` runs once at the end of `initNavigation`, MEASURED `js/navigation.js:95`)
and for viewport-driven stage changes.

**Why it is not optional:** §7's live context note must not echo the agent's own actions back to
the agent — it already learned them from the tool result (§5). An agent-caused change and a
visitor-caused change are **byte-identical in the state**, so no value-based dedupe key can tell
them apart. `origin` is the only discriminator. This is the real content of the plan's "deduped"
and the probable mechanism behind its UNVERIFIED "the journey suite caught the double-notify".

### 3.4 Subscription contract

```js
const unsubscribe = subscribe(fn)   // fn(snapshot, change)
// change === null                  → the immediate call on subscribe
// change === { field, from, to, origin }
```

- **Synchronous** on write. No microtask, no batching inside the store.
- **Called once immediately on subscribe**, with `change === null`. This matches the existing
  `chatBus.on` precedent (MEASURED `js/chat-bus.js:18` — `listener(currentState, currentDetail)`
  before returning). Two different subscribe conventions in one codebase is a bug generator; do
  not invent a second.
- **A write that does not change the value is a no-op** — no notify, no `change`. This is the
  first of the two dedupe mechanisms (§7.2 is the second).
- A throwing subscriber must not break the write or starve later subscribers: each callback is
  invoked inside a `try`/`catch`, and a throw is swallowed. The store is infrastructure; a
  consumer bug must not corrupt it. (Same posture as `alerts.py` under invariant #14.)
- Iteration is over a **snapshot of the listener set**, so subscribing or unsubscribing from inside
  a callback cannot skip a listener or loop forever.

### 3.5 Singleton, with a test reset

**Module singleton**, not injected. Precedent: `js/chat-bus.js` is already a module singleton
consumed by both `chat.js` and `app.js`; the site is one page with one instance; threading an
instance through `initNavigation` / `initContactForm` / `renderProjects` / `initChat` would be four
signature changes for no isolation benefit in the browser.

**But** it must export `__resetSiteStateForTests()`. MEASURED: this repo has **no test
dependencies at all** (`package.json` declares neither `dependencies` nor `devDependencies`) and no
per-file module isolation under `node --test`; a module singleton with no reset is untestable here.
The reset clears state to the initial shape **and** drops all listeners.

### 3.6 `gvp:site-chat-collapse` — **removed, not adapted**

MEASURED: the event has exactly **two emitters** — `js/projects.js:228` and `js/contact.js:77` —
and exactly **one listener**, `js/chat.js:1433`, whose body is
`closePanel({ restoreFocus: false, immediate: true })`. All three are in `js/`.

Both emitters are *also* the modules that become the writers of `project` and `contactOpen` (§3.2),
so converting them is the same edit that §3 already requires. An adapter for a three-call-site
in-repo event is pure carrying cost, and an adapter here is actively dangerous: a surviving
emitter still reaches `snapClose → stopVoice` (§9.1) and silently restores the defect the whole
milestone is about.

**Pinned by a grep assertion, deliberately:** `test/site-state.test.mjs` asserts that no file under
`js/` contains the string `site-chat-collapse`. The failure mode is a *leftover emitter*, which no
behavioural test on the new store can see. (Same technique as `test/frontend-no-secrets.test.mjs`.)

---

## 4. Decision — the stage reducer

### 4.1 It is `js/chat-stage.js`, not `js/chat-dock.js` — the plan's name collides

**Refuted on a MEASURED collision.** "Dock" is already taken in the exact file this code lands in,
and it means something unrelated:

- `let dockMode = 'text'` — values `'text' | 'voice'`, the **composer** mode (`js/chat.js:512`).
- `getEffectiveDockMode` (`:515`), `syncDockMode` (`:523`), `setDockMode` (`:542`).
- `<div id="chatDialogDock" class="chat-dialog__dock" data-dock-mode="text">` (`index.html:330`).
- Shipped analytics events `chat_dock_switch_text` / `chat_dock_switch_voice` (`js/chat.js:1443,1448`).

A second "dock" with four unrelated states inside the same ~2 000-line module is a defect waiting
to happen, and `chat.js` is explicitly **not** being split (plan § *Accepted residuals*).

Module `js/chat-stage.js`; store field `chatStage`; DOM attribute `data-chat-stage` on `#chatDialog`
(distinct from the existing `data-dock-mode` on its child). `docked` survives as a **state name** —
that is unambiguous in context. The plan's `chatLayout` field name would also have been fine;
`chat-dock.js` is the part that is rejected.

### 4.2 Two pure functions — this is the testability seam

```js
export function nextChatStage(stage, event, ctx) -> stage     // the reducer
export function stageChrome(stage)              -> chrome     // the a11y/chrome contract, as data
```

`ctx = { wide: boolean }`, where `wide` means viewport ≥ 768 px. **`wide` is injected and the
reducer never reads `window`** — that is what makes the breakpoint behaviour testable without a
browser.

`stageChrome` returning the chrome as **data** is the decision that lets §4.4 be pinned in
`node --test` with no DOM at all. MEASURED house style, quoted from `test/starfield-perf.test.mjs:4`:
*"No jsdom in this repo — a counting canvas stub is enough…"*. There is no jsdom, no linkedom, no
happy-dom. So the a11y contract is asserted as the **output of a pure function**, and the DOM
application is a handful of trivially-reviewable assignment lines in `chat.js`. Without this split,
the entire accessibility contract — the milestone's headline claim — would be checkable only
through new headless-Chromium infrastructure, which is the worst place to put the most important
assertion in the milestone.

### 4.3 The full transition table

Events: `open-text`, `open-voice`, `navigate`, `project-open`, `project-close`, `contact-open`,
`contact-close`, `escape`, `restore`, `minimize`, `close`, `viewport-narrow`, `viewport-wide`.
`W = ctx.wide ? 'docked' : 'minimized'`.

| event ↓ / from → | `closed` | `modal` | `docked` | `minimized` |
|---|---|---|---|---|
| `open-text` / `open-voice` | **`modal`** | `modal` | `modal` | `modal` |
| `restore` | `closed` ¹ | `modal` | `modal` | **`modal`** |
| `navigate` | **`closed`** ² | **`W`** | `docked` ³ | `minimized` ³ |
| `project-open` | **`closed`** ² | **`W`** | `docked` ³ | `minimized` ³ |
| `contact-open` | **`closed`** ² | **`minimized`** ⁴ | **`minimized`** ⁴ | `minimized` |
| `project-close` | `closed` | `modal` ⁵ | `docked` | **`W`** ⁶ |
| `contact-close` | `closed` | `modal` ⁵ | `docked` | **`W`** ⁶ |
| `escape` | `closed` | **`closed`** ⁷ | **`minimized`** | **`minimized`** ⁸ |
| `minimize` | `closed` | `minimized` | `minimized` | `minimized` |
| `close` | `closed` | `closed` | `closed` | `closed` |
| `viewport-narrow` | `closed` | `modal` ⁹ | **`minimized`** | `minimized` |
| `viewport-wide` | `closed` | `modal` ⁹ | `docked` | `minimized` ¹⁰ |

Bold = the cases the plan does not state. Notes:

1. **`restore` cannot resurrect a closed conversation.** `restore` means "bring back the panel
   you already have". Opening is `open-*`. Keeping them distinct is what lets M4's launcher
   "Assistant active" chip be a `restore` without accidentally becoming a cold open.
2. **`closed` is absorbing for every site event.** A visitor who has never opened the chat must not
   acquire a dock on their first nav click. This is the single most likely way to turn "the
   assistant yields the stage" into "the assistant is always on screen".
3. **Site events are idempotent in the yielded stages** — a second navigation while docked does not
   re-promote to `modal`. Promotion is a visitor act only.
4. **`contact-open` → `minimized`, always, at every width.** The contact dialog is itself modal
   (`aria-modal="true"`, `index.html:254`) and binds Escape; a docked card beside it competes for
   the same key and the same focus ring. This matches the plan's "`contact-open` → pill" and
   extends it to the `docked` → `minimized` case the plan omits.
5. A dialog closing never *demotes* an already-focused panel.
6. **The return path, which the plan omits entirely.** Without it, a visitor who opens a project
   dialog and closes it again is left with a pill and no stage, and an agent mid-sentence has
   nowhere to speak from. The pill earns its card back when the thing that displaced it goes away.
7. **Escape from `modal` closes.** This is today's shipped behaviour (MEASURED `js/chat.js:1425-1430`
   — Escape while open calls `closePanel`), preserved deliberately. No migration.
8. **Escape from `minimized` is a NO-OP.** A pill has nothing to dismiss, and at that moment Escape
   almost always means "close the dialog in front of me" — the contact or project dialog, not the
   conversation. Making Escape destroy a minimized conversation would discard the transcript on a
   keystroke aimed at something else.
9. Width never changes a focused panel. The visitor is looking at it.
10. **Widening does not auto-promote a pill.** The visitor minimized it; a resize is not consent.

**Voice is not an input to, nor an output of, this reducer.** `voiceActive` must not appear in
`nextChatStage`'s signature or body. Every defect in §9 is "a layout change killed the session";
a reducer that cannot see voice cannot stop it. The inverse is invariant #20 (§8).

### 4.4 The accessibility contract — `stageChrome(stage)`, normative

| stage | `dialogHidden` | `backdropHidden` | `scrollLock` (`body.chat-dialog-open`) | `ariaModal` | `moveFocus` | `pointerEventsOnShell` |
|---|---|---|---|---|---|---|
| `closed` | `true` | `true` | `false` | `'false'` | `'restore'` | `'none'` |
| `modal` | `false` | **`false`** | **`true`** | **`'true'`** | `'composer'` | `'auto'` |
| `docked` | `false` | **`true`** | **`false`** | **`'false'`** | **`'none'`** | **`'none'`** |
| `minimized` | `false` | `true` | `false` | `'false'` | `'none'` | `'none'` |

Load-bearing specifics, each grounded:

- **`aria-modal` becomes JS-managed.** MEASURED: it is a *static* attribute in the markup today —
  `<div class="contact-dialog__panel chat-dialog__panel" role="dialog" aria-modal="true" …>`
  (`index.html:300`). A docked card that still says `aria-modal="true"` tells a screen reader the
  rest of the page does not exist, which is the precise opposite of the milestone's claim. There is
  no way to make it honest except to derive it from the stage. `role="dialog"` stays in all stages.
- **The backdrop must be `hidden`, not transparent.** MEASURED: it is a real element —
  `<div class="contact-dialog__backdrop chat-dialog__backdrop" aria-hidden="true">`
  (`index.html:299`) — inside a `position: fixed; inset: 0` shell (`.contact-dialog`,
  `css/styles.css:1712-1715`), carrying `backdrop-filter: blur(14px)` (`css/chat.css:793-795`).
  **DERIVED:** a full-viewport `inset: 0` element with `opacity: 0` still consumes every click.
  Fading it would leave the site visually operable and functionally dead, with a green suite.
  **The test must assert that a click reaches a site element underneath** — a hit-test, not an
  opacity check. This is the single highest-value assertion in M2's app half.
- **The scroll lock is one CSS rule.** MEASURED: `body.chat-dialog-open { overflow: hidden }`,
  `css/chat.css:1-3` — the only scroll lock on the chat panel. In `docked`/`minimized` the class
  must be absent. One stray `classList.add` restores a locked page silently; see invariant #22.
- **The shell geometry must change too, not just its chrome.** MEASURED: `#chatDialog` carries class
  `contact-dialog chat-dialog` (`index.html:298`) and inherits `position: fixed; inset: 0` from
  `.contact-dialog`. A `docked` stage that only hides the backdrop still covers the viewport with an
  invisible shell. `docked` scopes the shell to the bottom-right card box.
- **Do not add a focus trap.** MEASURED: there is none today — `js/dialog-helpers.js` has only
  `setDialogVisibility` + `bindEscapeClosesDialogWhenOpen`, and `chat.js` has no `Tab` handler. So
  there is nothing to *remove* for `docked`, and nobody should "fix" the missing trap into it. If a
  trap is ever added for `modal`, `stageChrome` gains a `trapFocus` key and `docked` is `false`.
- **`moveFocus: 'none'` is the yield.** Entering `docked` or `minimized` must not move focus. The
  visitor just clicked a nav link; stealing focus back into the chat is the keyboard equivalent of
  the modal that this milestone removes.
- **Transcript `aria-live` is retained in every visible stage.** MEASURED: `<ol id="chatMessages"
  role="log" aria-live="polite" aria-relevant="additions text">` (`index.html:328`). A docked
  assistant that speaks without announcing is a worse regression than the modal.
- **Reduced motion.** Stage transitions reuse the existing `prefersReducedMotion()` gate already in
  `openPanel` / `closePanel` (`js/chat.js:959, 983`). **This does not touch invariant #6.** #6 is
  scoped to the canvas star/snow animation and its tiers in `js/starfield-prefs.js`; widening it to
  cover chat chrome would make it unfalsifiable by making it mean "the site honours reduced motion
  everywhere". Leave #6 alone. The stage-transition requirement is a clause of invariant #22 (§8).

---

## 5. Decision — tool results carry the resulting `siteState`; `inferPromisedNavigation` is rejected

### 5.1 The echo, and the one rule that makes it worth anything

Tool results become:

```js
{ result: 'navigated', section: '<resolved id>', siteState: <snapshot> }
{ result: 'opened_contact_form',                 siteState: <snapshot> }
```

**The snapshot is read back from the store after the change settled. It is never constructed from
the arguments.** Without the read-back the echo is the argument spelled twice, and it would lie in
at least one MEASURED case:

> **The no-op hash write — a fifth cause the plan does not list.** `navigateToSection` does
> `window.location.hash = '#labs'` (`js/chat.js:1500`). Per the HTML spec, assigning the *same*
> fragment dispatches **no** `hashchange`, so `navigateByHash` (`js/navigation.js:63`) never runs —
> yet the function returns `{ result: 'navigated', section }` unconditionally (`:1504`). Benign
> today (the visitor is already there), but under a self-verification contract it makes the tool
> result false, and false is worse than missing.

Mechanism: `navigateToSection` subscribes, performs the change, and resolves when the store reports
the target — or after **250 ms** returns `{ error: 'navigation_did_not_apply', siteState }`. The
reducer stays pure; the waiting lives in the chat module.

### 5.2 `inferPromisedNavigation` — **REJECTED**

The orchestrator asked for a ruling. The ruling is no, and the reasoning is recorded because the
existing `shouldRevealResumeButton` makes the idea look safer than it is.

1. **The precedent is not comparable.** MEASURED: `shouldRevealResumeButton`
   (`js/voice-resume-button.js:14`, `return mentionsButton && mentionsResume`) fires a **reveal** —
   it adds a button the visitor may ignore. Worst case: a redundant button. Navigation **moves the
   visitor's page**. Worst case: hijacking someone mid-paragraph because the model said the word
   "portfolio".
2. **It is unfalsifiable in the direction that matters.** The navigation version must separate
   *"let me take you to the portfolio"* from *"his portfolio covers fifteen years"*. MEASURED: the
   team already had to hand-write that negative for the **easier** problem —
   `test/voice-resume-button.test.mjs:37`, `shouldRevealResumeButton('His resume covers fifteen
   years of work.', [])` must be `false`. The two-token heuristic barely survives the easy case.
3. **It fixes the wrong layer.** §9 pins **five mechanical causes** of "confirmed but never
   executed". Every one is deterministic and closed by code in this milestone. A prose heuristic
   layered on top would mask whatever residue remains and make the journey suite pass for the wrong
   reason. The plan's framing — *"after the model said 'taking you there'"* — is a **symptom** of
   the mechanical bugs, not an independent failure mode.
4. **Cheaper replacement, which also answers the question with data.** New analytics event
   `chat_nav_promise_gap` — the assistant's finished text matched a navigation-intent phrase AND no
   `navigate_to_section` ran this turn. **Recorded, never acted on.** The predicate may be as loose
   as we like, because it triggers nothing. If the counter is non-trivial on real traffic after M2,
   revisit — a safety net justified by a number is a different decision from one justified by a
   transcript, and it supersedes this ADR when it comes.

**Residual, recorded:** if the voice model genuinely promises and never calls the tool, the visitor
hears a promise and nothing moves. That is a **prompt** defect. Fix it where a wrong answer is
recoverable: the tool description and the system prompt (ADR-0010's prompt work, unshipped).

---

## 6. Decision — the `siteState` wire contract

### 6.1 Shape, on the wire

```jsonc
"siteState": {
  "section":      "portfolio",   // ≤32,  ^[a-z][a-z0-9-]{0,31}$   REJECT on violation
  "projectId":    "team-tactics",// ≤64,  ^[A-Za-z0-9._-]{1,64}$   REJECT on violation
  "projectTitle": "Team Tactics",// ≤120, free text                CLAMP (truncate)
  "contactOpen":  false,
  "voiceActive":  true
}
```

Five keys, flat, **depth 1 by construction**, `extra='forbid'` on the sub-model so a caller cannot
add a sixth. One shared pydantic class — `SiteStateIn` — used by **both** `ChatRequest` and
`LiveSessionRequest`. Not two classes: `providers.py` and `live_gemini.py` have already drifted
once on exactly this kind of duplication (§9.3).

Two deliberate differences from the store's shape:

- **`chatStage` is not on the wire.** The model has no action that depends on whether its own window
  is docked or minimized. Shipping it adds key space and prompt tokens for nothing. Adding it later
  is additive — no ADR needed.
- **`project` is flattened** to `projectId` + `projectTitle`. The store keeps the nested object
  because that is ergonomic in JS; the wire is flat because invariant #17 requires bounding
  **shape (depth)**, and a flat five-key object has a *provable* depth of 1 and needs no
  `_MAX_ARG_DEPTH` walk. The FE seam does the conversion.

### 6.2 Absent, and malformed

- **Absent** → the "Current site state" system line is **omitted entirely**. Not emitted as
  "unknown", not defaulted to `home`. The model must not be told a fact nobody asserted. An older
  frontend against a newer server keeps working unchanged.
- **Malformed** → **400 `validation_error`** for the whole request, via this app's existing
  `RequestValidationError` handler (MEASURED `main.py:1266-1283`, which already converts 422 → 400).
  Not clamped.

  This departs from `/api/live/transcript`'s clamp posture, and invariant #17 is the reason, not an
  exception to it. #17's rule is **"clamp values, reject identities"**. `section` is an **enum key**
  and `projectId` is a **record key** that M4 explicitly wants as an admin facet — both are
  identities. Silently rewriting an identity is the failure #17 names: callers sharing a truncated
  prefix collide into one bucket. Second reason: unlike `/api/live/transcript`, which #17 documents
  as *"a fire-and-forget `keepalive` beacon that never reads the response"*, `/api/chat` **is** read
  by its caller, so a 400 is actionable rather than lost. `projectTitle` is the only free-text
  value and the only clamp.

- **An unknown but pattern-valid `section` is ACCEPTED, not rejected, and passed through verbatim.**
  **This is the migration note.** The frontend and the chat host deploy independently
  (`scripts/integrate-and-deploy.sh` ships the site and the SAM stacks in one run, but Amplify
  serves `main`'s HTML as-is per invariant #11, so skew is real and has already caused one
  incident). ADR-0011's rename will reach one side before the other. A server that 400s an
  unrecognised section id turns an IA rename into a **site-wide chat outage**. The value is already
  bounded in length and charset; validating it against a server-side enum buys nothing and costs
  availability.

### 6.3 The bound — two constants to multiply, per invariant #17's method

Per request, caller-controlled text inside `siteState`: `32 + 64 + 120 = 216` characters, plus the
five fixed keys and JSON punctuation. **Bound: ≤512 bytes serialized.** DERIVED by addition from the
field caps, not measured — do not re-measure it; if the caps change, redo the addition.

Bounded in **count** (5 fixed keys, `extra='forbid'`), **size** (above; the patterns are ASCII-only
so characters = bytes), **depth** (1, by construction — §6.1), and **key space** (the keys are
fixed). **Not** bounded in the *cardinality* of `section` / `projectId` values across requests —
the same residual #17 names for tool names, and for the same structural reason (cardinality is a
cross-request property a sink cannot see). It only matters if those values become histogram keys:
see §6.4.

### 6.4 Persistence — it is a sink, so it is treated as one

`siteState` **is** persisted on the turn. It is genuinely useful (the admin panel can see what the
visitor was looking at when a turn failed) and it is already bounded.

Rules:

- Persist **the validated model's dump**, never `payload` raw. MEASURED precedent in the same
  function: `_persist_text_turn` already does `'requestMessages': [row.model_dump() for row in
  payload.messages]` (`main.py:811`). Follow it exactly.
- **If any admin rollup ever keys a histogram or facet by `section` or `projectId`, that is a new
  cardinality sink and needs its own slice.** MEASURED lesson: `aws/src/contact-admin.js:373`
  already builds the tool histogram keyed by a persisted value, which is why #17's cardinality
  residual exists. M4 wants exactly this for `projectId`. **Filed forward; do not build it in M2.**

### 6.5 One formatter, in a leaf module

```python
# docker/chat/app/site_state.py  — pure leaf: no FastAPI, no boto3, no I/O
def format_site_state_line(site_state: SiteStateIn | None) -> str: ...   # '' when None
```

Mirrors `turn_input.py`'s shape (MEASURED: #17 describes it as *"a pure leaf module (no FastAPI, no
boto3, no I/O)"* whose bounds are *"module-private constants"* asserted **from the outside as
behaviour**, so a bound and its test cannot be changed in one edit). Adopt the same discipline here.

Both `/api/chat` and `/api/live/session` call this one function. One line, one format, one place.

### 6.6 The live-instruction budget — a MEASURED trap

`build_live_system_instruction` (`docker/chat/app/knowledge_context.py:411-436`) computes:

```python
max_total   = max(6000, min(int(os.environ.get('CHAT_LIVE_SYSTEM_MAX_CHARS') or 14000), 32000))
budget_pack = max(3500, max_total - len(prompt_body) - 900)
if len(blob) > budget_pack: blob = _truncate_text(blob, budget_pack)
```

The `900` is the reserve for `voice_rules`. **A site-state line appended after this arithmetic
silently overruns `CHAT_LIVE_SYSTEM_MAX_CHARS`**, and the symptom is not an error — it is a
**truncated knowledge pack**, i.e. the voice agent quietly forgetting part of the portfolio. The
site-state line must be included **before** the pack is truncated: either the reserve becomes
`900 + len(site_line)`, or `site_line` is a parameter folded into the computation. Pin it with a
test that the total instruction length stays ≤ `max_total` **with** a maximal site-state line.

### 6.7 SECURITY_GLOB clearance — scoped

MEASURED (`.claude/tdd.config:68`): `SECURITY_GLOB` matches
`docker/chat/app/(main|lambda_handler|live_env|live_gemini)\.py`. `guard-edit-scope.sh:96-107` blocks
those paths **in every phase, including `off`**, unless `SECURITY_REVIEW=1` is set for the edit.

M2's chat half touches **`main.py`** (the `SiteStateIn` sub-model and threading it into two routes)
and **`live_gemini.py`** (the enum alignment, §9.3). **This §6 is the architect review those edits
require**, and its clearance is scoped to exactly:

1. adding `SiteStateIn` and the optional `siteState` field on `ChatRequest` / `LiveSessionRequest`;
2. calling `format_site_state_line` in `chat()` and `live_session()` and folding the line in;
3. persisting the validated dump per §6.4;
4. aligning the `navigate_to_section` enum and fixing the stale `providers.py` docstring (§9.3).

It clears **nothing else** on those files. Any other edit needs its own review.

---

## 7. Decision — live-session context notes

### 7.1 Trigger

A `subscribe` callback, which pushes a note **only when both** hold:

- `getSiteState().voiceActive === true` — no live session, no note; and
- `change.origin === 'visitor'` — an **agent**-origin change is **never** notified. The agent
  already received it in the tool result (§5.1). This is the dedupe (§3.3).

`origin === 'system'` (boot, viewport) is also not notified: boot cannot coexist with an open
session, and a resize is not a fact about the site.

### 7.2 Dedupe key and cadence

- **Coalesce on a trailing 250 ms window.** At most one `clientContent` per window, carrying the
  **whole** "Current site state" line — not per-field deltas. One nav click can write `section` and
  `project: null`; two notes for one visitor action **is** the double-notify. Coalescing to one
  whole-state line makes the note idempotent by construction.
- **Dedupe key = the rendered line itself**, compared against the last line *actually sent on this
  live session*. Reset on session open and on `stopVoice`. Not a time window — the failure mode is
  "the same fact told twice", not "told too often". This catches the second mechanism that §3.4's
  no-op rule cannot: two *different* writes landing on the same rendered state (e.g.
  `contact-close` then `project-close` both re-rendering `section: portfolio`).

### 7.3 Shape and failure posture

```json
{ "clientContent": { "turns": [ { "role": "user", "parts": [ { "text": "<line>" } ] } ],
                     "turnComplete": false } }
```

`turnComplete: false` is the whole point: the note must not consume a turn or provoke a reply.

**Hard rules.** The notifier is fire-and-forget. It must never throw into the store's notify loop
(§3.4 catches, but the notifier must not rely on that). It must **never call `stopVoice`** —
invariant #20. If the WebSocket is not `OPEN`, drop the note **silently**: it is a courtesy, and the
model will get the truth from the next tool result. Same posture as `alerts.py` under invariant #14.

---

## 8. New invariants M2 should land

Next free number is **#20** — MEASURED: `docs/tdd/project-invariants.md` runs #1 … #19.

- **#20 — A site-layout or navigation change never terminates a live voice session.** `[app]`
  No path reachable from a `siteState` write, a stage transition, a navigation, a project dialog, or
  the contact dialog may call `stopVoice` or close the live WebSocket. Voice ends only on an
  explicit visitor act (mic stop, panel close, start-over) or a transport failure.
  *Pin:* drive every event in §4.3 and every writer in §3.2 against a `stopVoice` spy that must stay
  at **zero** calls. **This is the invariant form of §9's root cause** — the one clause of M2 that,
  if it regresses, silently restores the entire defect. Strongest of the three; land it first.

- **#21 — A tool result the agent can self-verify against is read back from the state, never
  constructed from the request.** `[app]` Any tool result asserting a site change reads the
  post-change store snapshot; a change that did not apply returns an error, not a success.
  *Pin:* the no-op-hash case (§5.1) — navigating to the already-active section must not return
  `{ result: 'navigated' }` unless the store actually shows the change. Weakest of the three;
  promote it only if the navigator wants the agent's truthfulness fenced as a standing rule rather
  than as a feature test.

- **#22 — While the assistant is yielded (`docked` / `minimized`), the site remains operable.**
  `[app]` No backdrop intercepting clicks, no `body` scroll lock, `aria-modal="false"`, no focus
  move on entry, no focus trap; and the transcript keeps its `aria-live`. Stage transitions honour
  `prefers-reduced-motion`.
  *Pin:* `stageChrome` (§4.2) asserted per stage, **plus** a hit-test that a click reaches a site
  element beneath the shell.
  **Recommend promoting it** — against the file's own stated bar, deliberately. The invariants file
  reserves itself for durability/safety/secret/correctness defects and declined to promote the
  voice-résumé net on that ground. This clears the bar anyway: the regression is **one
  `classList.add` or one CSS line**, it is invisible in a diff review, it degrades the site for
  exactly the users who depend on assistive technology, and it is the whole user-visible claim of
  the milestone. If the navigator disagrees, it stays a feature test with the same assertions — the
  assertions are not negotiable either way.

Invariant **#6 is not touched, and should not be widened** — see §4.4's last bullet.

---

## 9. Verification of the plan's root cause

The orchestrator asked for this before anything was enshrined. Verdict: **the root cause is real,
the mechanism is confirmed, and the plan's statement of it is wrong in four places and incomplete
in one.** All five corrections matter to the slices.

### 9.1 (a) The teardown — **CONFIRMED, with one correction**

The chain is intact, MEASURED end to end:

```
js/app.js:242-244        if (state === 'portfolio' || state === 'labs') { collapseChatDialog() }
js/chat.js:239-241       export function collapseChatDialog() { collapseChat() }
js/chat.js:1020          collapseChat = () => closePanel({ restoreFocus: false, immediate: true })
js/chat.js:983-986       if (immediate || prefersReducedMotion()) { snapClose({ restoreFocus }); return }
js/chat.js:901-909       if (liveVoice?.isSessionOpen?.() || liveUi.connecting || liveUi.active
                             || voiceStartRequested) { liveVoice?.stopVoice?.({ silent: true }) }
js/chat-live.js:714-770  stopVoiceInternal → ws = null; w.close()
```

Two further emitters reach the same place through the event (MEASURED):
`js/projects.js:228` and `js/contact.js:77` dispatch `gvp:site-chat-collapse`;
`js/chat.js:1433-1435` listens and calls the identical `closePanel({ immediate: true })`.
And the text-chat contact action does it directly: `openContactFromChat` →
`closePanel({ restoreFocus: false, immediate: true })` (`js/chat.js:1026`).

**Correction — "on every navigation" is false.** The call is **guarded** by
`state === 'portfolio' || state === 'labs'` (`js/app.js:242`). **Navigating home does not tear the
panel down.** This matters: a slice written to "stop collapsing on navigation" would, taken
literally, be looking for a call that is not there in the home case, and any journey asserting
"navigation never kills voice" that exercises only `→ home` would pass against the unfixed code.

### 9.2 (b) Exact-matching ids — **HALF REFUTED**

MEASURED, `js/chat.js:1496-1505`:

```js
const navigateToSection = (section) => {
  if (section === 'home') { history.replaceState(null, '', './');
                            window.dispatchEvent(new HashChangeEvent('hashchange')) }
  else if (section === 'labs' || section === 'playground') { window.location.hash = '#labs' }
  else if (section === 'portfolio') { window.location.hash = '#portfolio' }
  else { return { error: `unknown_section: ${section}` } }
  return { result: 'navigated', section }
}
```

- **Refuted:** legacy `playground` does **not** silently fail. It is handled explicitly, and so is
  the IA rename. The plan's example is out of date.
- **Confirmed, and this is the real defect:** the match is **byte-exact**. `"Portfolio"`,
  `" portfolio"`, `"Labs"`, `"work"`, `"experience"` all fall to `unknown_section`. No `trim`, no
  `toLowerCase`. §2.1's `resolveNavTarget` closes it.
- **Sharper than the plan, and worse:** on the **text** path the return value is **discarded** —
  `navigateToSection(actionEl.dataset.section || '')` (`js/chat.js:1460`), result unused. So a bad
  section is a **silent no-op with no feedback to anyone**. On the **voice** path it at least
  round-trips as a tool error (`js/chat-live.js:977-990`). The two paths fail differently, and the
  text path fails worse. Pin both.

### 9.3 (c) "the Live-mode path" — **PINNED, and it is two concrete things, neither of them vague**

The orchestrator asked me to pin it or refuse to carry it. It pins, to two MEASURED defects.

**(c1) The `open_contact_form` tool response is never sent — the model never learns the form opened.**

MEASURED ordering, `js/chat-live.js:966-992`:

```js
const out = await onToolCall(name, args)   // :977
...
if (responses.length && ws && ws.readyState === WebSocket.OPEN) {   // :988
  ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }))   // :990
}
```

`ws` is the closure variable `let ws = null` at `js/chat-live.js:521`, and
`stopVoiceInternal` sets `ws = null` **synchronously** (`:756`).

- `open_contact_form` → `openContactFromChat` → `closePanel({ immediate: true })` **synchronously**
  (`js/chat.js:1026`) → `snapClose` → `stopVoice` → `ws = null`. Control returns to `:988`, the
  guard is false, **and the `toolResponse` is dropped entirely.** DERIVED from the two MEASURED
  facts. Per the Live protocol the model is then waiting on a function response that will never
  arrive, on a socket that is already closing.
- `navigate_to_section` fails **differently**: `window.location.hash = '#labs'` queues
  `hashchange` as a **task**, so the `await` of a non-promise resolves in a microtask and `:990`
  runs **before** the teardown. The model *does* receive `{ result: 'navigated' }`, and then the
  socket dies mid-sentence.

Two different failures from one bug. The dropped-response case is strictly worse and the plan does
not distinguish them. Pin both orderings.

**(c2) The two tool declarations have drifted, and the live one still advertises a section the site
no longer has.**

MEASURED:

| | file:line | `section` enum |
|---|---|---|
| text | `docker/chat/app/providers.py:140` | `['home', 'portfolio', 'labs']` |
| voice | `docker/chat/app/live_gemini.py:76` | `['home', 'portfolio', 'playground']` |

The live description reads *"when the user asks to go to Home, Portfolio, or
Playground/Experiments"* (`live_gemini.py:73-75`). The site's page is **Labs** (ADR-0011 renamed it;
`js/section-names.js:5-9`). So the voice model is told to call the section "Playground", will *say*
"Playground" to visitors, and cannot emit `labs` at all — it only works because §9.2's legacy alias
is still there. And `providers.py:91-93`'s own docstring says the text tools are *"the same two
declarations Live uses, **minus** `navigate_to_section`"* — **contradicted by its own code 40 lines
below**, which declares it.

**Refuted, same drift, in the backlog:** `.claude/state/backlog.md:107-110` (Track C item 5) still
asks to *"close the `providers.chat_tools()` gap vs `live_gemini` having `navigate_to_section`"*.
That gap is **closed** — `providers.py:133` declares it. And Track C's design note says the enum
should become `work / experience / home`, which is ADR-0011's unshipped vocabulary (§2).

### 9.4 A fifth cause the plan does not list

The no-op hash write — §5.1. MEASURED + DERIVED.

### 9.5 Collateral drift found while verifying, filed for the loop (not fixed here)

- **`language` is sent and silently dropped.** MEASURED: `js/chat.js:1161` sends
  `{ messages, stream, sessionId, language: currentLanguage }`; `ChatRequest` (`main.py:191-194`)
  declares no `language` field and the model sets no `model_config`, so pydantic v2's default
  `extra='ignore'` discards it, and `grep -n language docker/chat/app/*.py` finds no reader.
  **The language the visitor is typing in has never reached the backend.** Two consequences: the
  forward-compatibility of adding `siteState` is MEASURED, not assumed (an older server ignores it);
  and `language` is either dead wire to delete or a feature that was never wired. **Architect's
  call: file it, decide it in M4, do not fold it into M2** — it is a separate claim.
- **`buildChatRequest` must stay the single serializer.** MEASURED `js/chat-payload-hash.js:21-30`
  and the comment at `js/chat.js:1150-1156`: the `x-amz-content-sha256` digest must cover the exact
  bytes sent, so `siteState` has to enter the object **passed into** `buildChatRequest`. Any slice
  that stringifies the body a second time breaks the CloudFront + OAC front door with a 403.
- **`z-index`, for M4's benefit.** MEASURED: `.chat-dialog { z-index: 1095 }` (`css/chat.css:777-779`),
  `.project-dialog { z-index: 1100 }` (`css/styles.css:624`), `.contact-dialog { z-index: 1090 }`
  (`css/styles.css:1715`). M4's claim is correct.
- **ADR-0010 and ADR-0011 are Accepted and contradicted by a green test.** §2.

---

## 10. Consequences

**Enabling.** The app and chat halves of M2 can be built in parallel against §6's five-field wire
contract and §4's two pure functions. `nextChatStage` / `stageChrome` / `resolveNavTarget` /
`format_site_state_line` are all pure leaves, testable with no DOM and no network — which matters
in a repo with zero test dependencies.

**Costs and risks.**

- `js/chat.js` gains a stage concept beside its existing, unrelated "dock" concept. §4.1 mitigates by
  naming, not by splitting the file (splitting is an accepted residual).
- `aria-modal` moves from markup to JS. The static attribute was *wrong* in the yielded stages; a
  JS-managed one can be wrong in *all* stages if the glue breaks. That is why `stageChrome` is
  asserted as data (§4.2) and the glue is kept to assignments.
- `siteState` is a new field on two public unauthenticated routes. §6.3's bound and §6.4's
  persistence rule are what keep it inside invariant #17 rather than reopening it.
- The cardinality of `section` / `projectId` across requests is **not** bounded (§6.3) and becomes a
  real sink the moment an admin rollup keys on it (§6.4). Filed forward to M4.

**Migration notes.**

1. **`gvp:site-chat-collapse` is removed** (§3.6). Two emitters and one listener, all in `js/`,
   all converted in the same milestone. Pinned by a grep assertion — the failure mode is a leftover
   emitter, which no behavioural test can see.
2. **An unknown-but-valid `section` is accepted by the server**, never 400'd (§6.2). Frontend and
   chat host deploy independently; rejecting unknown ids turns an IA rename into a chat outage.
3. **`siteState` is optional on both routes.** Old frontend + new server: no site-state line. New
   frontend + old server: pydantic's default `extra='ignore'` drops it (MEASURED via `language`,
   §9.5). **No coordinated deploy is required in either direction.**
4. Escape from `modal` still closes (§4.3 note 7). No visitor-facing behaviour change there.

---

## 11. Recommended changes to M2's slice list

1. **Resolve §2 first.** One navigator decision, zero slices. M2 is not *gated* on it under
   Decision 2.1, but an Accepted ADR contradicted by a green test should be resolved explicitly.
2. **Add a slice the plan omits, and put it first in the chat half:** align the `live_gemini.py`
   enum with `providers.py` and fix the stale `providers.py` docstring (§9.3). Two lines of code,
   on `SECURITY_GLOB`, and a **precondition** for every voice assertion in the journey suite to mean
   anything. Add the equality/subset test from §2.1 with it.
3. **Reorder: the `stopVoice`-spy test (invariant #20) becomes slice 1 of the app half**, before
   `site-state.js`. The plan buries "site events never call stopVoice" inside the journey harness at
   the end. That puts the single most important property of the milestone in its most expensive and
   most flake-prone venue. It is pinnable as a plain `node --test` with an injected spy — cheap,
   deterministic, and it fails the moment a later slice reintroduces the teardown. Keep the journey
   version too; do not rely on it alone.
4. **Drop `inferPromisedNavigation`** (§5.2). One slice out. Replace with the smaller
   `chat_nav_promise_gap` counter.
5. **Split the "confirmed but never executed" work into the five causes §9 actually found**, each
   with its own red test: the guarded teardown (§9.1), the **dropped** `toolResponse` for
   `open_contact_form` (§9.3 c1), the **discarded** return value on the text path (§9.2), the
   byte-exact match (§9.2), and the no-op hash write (§9.4). The plan's three-cause framing merges
   two distinct voice failures into one and misses two causes entirely.
6. **Move the journey harness to the end of M2, and let no acceptance bullet depend on it alone.**
   MEASURED: `scripts/qa/` does not exist; the repo has **no browser E2E at all** (`CLAUDE.md`:
   *"No browser E2E suite; verify UI manually"*) and **no test dependencies whatsoever**
   (`package.json`). Standing up headless Chromium is its own project with its own flake budget.
   §4.2's `stageChrome` seam exists precisely so M2 can be *done* without it; the journey then
   confirms the glue once, rather than carrying the contract.
