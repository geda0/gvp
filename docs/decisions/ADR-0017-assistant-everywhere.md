# ADR-0017 — Assistant everywhere: one layer for the modal and one for the yield, two project tools, and the seams that make "only on a tap" true

- Status: Accepted
- Date: 2026-10-23
- Seam owner: architect
- Cited by: **M4** (`docs/plan-2026-09-port.md` § *M4 — Assistant everywhere*).
- Extends: **ADR-0015** — §4 (one new reducer event, one new `ctx` key, one optional `stageChrome`
  parameter), §5 (two new tool results under the same read-back rule) and §6 (one new top-level
  request field, not a sixth `siteState` key). Every extension here is **additive**, which is the
  envelope ADR-0015's own header grants M4. §2 **confirms** ADR-0015's yielded-layer decision and
  **refutes** the plan's attempt to reverse it.
- Touches: project invariants **#17** (a new read-side facet keyed by a persisted value — §8 is the
  ruling ADR-0015 §6.4 filed forward), **#20** (two new agent-origin writers must stay inside it),
  **#21** (two new self-verifiable tool results), **#22** (one clause added, §10). Proposes **#23**.
- Supersedes: nothing. §11 **refutes or corrects eleven claims** in the plan's M4 text and one in
  its execution-order line. §12 files five pre-existing defects found while verifying. Refutations
  are recorded, not deleted.
- **Security review for `SECURITY_GLOB` paths:** §9.4 is the scoped clearance. It covers four files
  and nothing else.

---

## 0. How to read this ADR

Facts labelled **MEASURED** were read out of the repo on branch `agent` on 2026-10-23 at `704811a`
and re-checked at `8597686`, and are cited to `file:line`, or were produced by running something
named here. **DERIVED** facts follow from a MEASURED fact by argument, not by observation. **UNVERIFIED** facts come from the
2026-08 transcript via `docs/plan-2026-09-port.md` and could not be checked here — they are carried
as claims, not as state. Line numbers drift; the cited symbol is the anchor.

**Suite baseline, MEASURED by running both — and it moved while this ADR was being written, which
is recorded rather than smoothed over.** At `704811a`, app `node --test` reported **415 tests / 413
pass / 1 fail / 1 skipped**; the one failure was `test/deploy-script-no-use-before-define.test.mjs`,
an **in-flight RED from a concurrent slice** on an unrelated track (deploy scripting). That track
landed two commits mid-write (`c8910ba`, `8597686`) and the same command at `8597686` reports
**415 tests / 414 pass / 1 skipped**. Chat `pytest`: **213 passed**, unchanged. Nothing in §2–§12
depends on either number. (The plan's "baseline at plan time" of 203/202 and 114 is stale by three
milestones.)

**Browser baseline, MEASURED** by driving the repo's own harness (`scripts/qa/cdp.mjs`) against a
static server, at 1280×900, 1512×950 and 420×820, headless Chrome, 2026-10-23. Every number in §2
and §6 labelled *browser-measured* comes from that run. The harness needed no new dependency: it is
a raw CDP client and `page.send(...)` reaches any CDP method.

**Live-instruction baseline, MEASURED** by importing `app.knowledge_context` and running
`build_live_system_instruction` on the committed pack. The numbers are in §4.2 and they change what
M4 can promise on the voice path.

---

## 1. Context

M4's claim is one sentence: **the assistant is reachable and useful from wherever the visitor
already is, and nothing it offers moves the visitor's words anywhere they did not send them.**

The first half is a layout and tool problem. The second half is a privacy claim, and a privacy
claim stated as an intention is not a claim at all — §7 exists to give it a seam.

M2 (ADR-0015) built the machinery M4 stands on: an observable store with one writer per field and a
mandatory `origin`, a pure stage reducer over `closed | modal | docked | minimized`, a `stageChrome`
function that returns the a11y contract as data, a five-key `siteState` wire bounded under invariant
#17, and three new invariants. M4 adds: one reducer event, two tools, one admin route, seven
analytics events, and a deferred microphone. Four of those five touch seams M2 defined, and the
plan's M4 text was written **before** M2 existed in this repo — against a different snapshot, by a
session whose numbering and prompt versions do not match ours. So §11 verifies it before anything
here is enshrined, and the answer is that M4's text is wrong or stale in eleven places, including
one that would directly reverse a green test and reintroduce a browser-measured regression.

---

## 2. Decision — the layering conflict: raise the MODAL stage, never the yielded one

This is the single biggest conflict between the plan's M4 text and what M2 shipped, and the resolution
is that the plan is **half right in a way that only looks like a contradiction because the plan treats
"chat" as one layer when M2 made it two.**

### 2.1 The stack, MEASURED

| element | selector | `z-index` | file:line |
|---|---|---|---|
| project dialog | `.project-dialog` | **1100** | `css/styles.css:624` |
| chat, **modal** stage | `.chat-dialog` | **1095** | `css/chat.css:778` |
| contact dialog | `.contact-dialog` | **1090** | `css/styles.css:1715` |
| chat, **yielded** stages | `#chatDialog[data-chat-stage='docked'\|'minimized']` | **1085** | `css/chat.css:2355` |
| site header (and the launcher in it) | `header` | **1010** | `css/styles.css:407` |
| spaceman | `#spacemanContainer` | 1020 | `css/spaceman.css:743` |

`test/chat-stage-layering.test.mjs` is **green** and pins two rules, not three numbers:

- *"a MODAL stage may sit above the site's dialogs — that is what modal means"* (`:24-25`), asserted
  today only as `modal > contact` (`:73-83`);
- *"a YIELDED stage must sit below anything the visitor is currently interacting with"* (`:25-27`),
  asserted as `yielded < contact` **and** `yielded < project` (`:52-71`).

Its comment records the browser measurement that produced it: at 1095 vs 1090 the minimised pill
floated over the contact form the visitor was filling in, invisible at 1024×768 because the two
happen not to overlap there.

### 2.2 The symptom is real, and the cause is one step earlier than the plan says

**Browser-measured, 1280×900 and 1512×950, with a project dialog open:**

- `document.elementFromPoint` over `#agentNode` (the header launcher) returns **the project
  dialog**, and so is every other chat entry point: the header is 1010, the spaceman 1020, and
  `.project-dialog` is a `position: fixed; inset: 0` flex container (`css/styles.css:621-629`)
  carrying a **click-eating, 72%-opaque** backdrop — `rgba(10, 14, 24, 0.72)` plus
  `backdrop-filter: blur(16px)`,
  `position: absolute; inset: 0` (`:636-642`). **With a project card open, nothing in the site can
  open the chat.** That is the plan's symptom, and it is not caused by the z-order comparison it
  names — it is caused one layer earlier, by a full-viewport backdrop over every launcher. The
  alpha is irrelevant to that: an `inset: 0` element consumes every click at any opacity, which is
  the same argument ADR-0015 §4.4 made one layer down about the chat's own backdrop.
- Forcing the chat open anyway (`window.dispatchEvent(new CustomEvent('gvp:open-chat'))`): the stage
  becomes `modal`, the project dialog stays open, and `elementFromPoint` **at the chat panel's own
  centre** returns the project dialog. The chat panel measures 672×481 centred at the same `cx` as
  the project panel's 739.59×750. So the modal chat opens **invisible and unclickable** behind it.

**DERIVED:** that second state is unreachable today precisely *because* of the first — there is no
way to ask for the chat from behind the backdrop. **M4's own project chips are what make it
reachable**, because they are the first chat affordance that lives *inside* `#projectDialog`. The
latent defect and the feature that exposes it arrive in the same milestone.

### 2.3 Decision 2.3 — `.chat-dialog` goes 1095 → **1105**. The yielded rule stays at 1085.

- **The modal stage is raised above `.project-dialog`.** This is what the plan's "chat `1105`" was
  reaching for and it is correct, for the modal stage only. It is consistent with the shipped test's
  *stated* rule (a modal may sit above the site's dialogs) and it fixes the measured defect in §2.2.
  Make `chat-stage-layering.test.mjs`'s second test assert `modal > project` as well as
  `modal > contact` — today it asserts only the weaker half, which is why the defect fits through.
- **"pill `1106`" is REFUTED outright.** 1106 is above `.project-dialog` (1100) and `.contact-dialog`
  (1090), so it reverses the first test in that file and reinstates the exact regression its comment
  records from a browser. A yielded card that still covers the form you are typing into is not
  yielded. **What it would cost, stated plainly:** invariant #22's letter would survive (no backdrop,
  no scroll lock, `aria-modal="false"`, `pointer-events: none` on the shell) while its claim — *the
  site remains operable* — failed, because the 384×540 docked card would sit on top of the 739.59×750
  project panel at every viewport below ~1547 px (§2.4). A green suite and an unusable dialog is the
  precise failure mode M2 spent a critic pass finding.

**Cost of this decision, stated:** nothing in M4 can make a *yielded* assistant visible while a
project dialog is open at a narrow viewport, because at 1085 it is behind that backdrop. §2.5
is what M4 does about that instead, and it is a stage decision rather than a z-index one.

### 2.4 Decision 2.4 — `hasRoomBesideDialog` is a pure function of measured widths, not a breakpoint

The plan says *"≥1100 px the dialog shifts left beside the docked card"*. Two things are wrong.

**The threshold is wrong.** MEASURED geometry: `.project-dialog__panel` is
`max-width: min(42rem, calc(100vw - 2rem))` with `padding-inline-end: 2.75rem`
(`css/styles.css:651-666`), browser-measured at **739.59 px** wide (root font-size a plain 16 px,
browser-measured, so 42 rem = 672 px plus the inline-end padding and borders). The docked card is
`width: min(24rem, calc(100vw - 2rem))` (`css/chat.css:2378`), browser-measured at **384 px**, with
`padding: clamp(0.75rem, 2vw, 1.25rem)` on its shell (`:2347`).

- With the dialog **centred** (today's layout), no overlap needs
  `(W − 739.59) / 2 ≥ 384 + gutter`, i.e. **W ≥ 1547 px** at a 20 px gutter. DERIVED. At 1512 px —
  a common laptop — the two still overlap by ~18 px (browser-measured: dialog `x ∈ [386, 1126]`,
  card `x ∈ [1108, 1492]`).
- With the dialog **shifted**, it needs `739.59 + 384 + 3 × gutter ≤ W`, i.e. **W ≥ ~1184 px** —
  still not 1100.
- At 1280 px, browser-measured, 134 of the card's 384 px sit behind the dialog panel.

**"The dialog shifts left" is REJECTED as a decision.** It inverts invariant #22. #22 says the
assistant yields so the site stays operable; a rule where opening the assistant **re-lays-out the
site's dialog** makes the site the thing that yields. It also means the project dialog's geometry
becomes a function of chat state, so every project-dialog test acquires a hidden dependency on the
assistant.

**The seam.** A pure predicate, exported from `js/chat-stage.js` beside the reducer (same module,
same seam, no new file):

```js
export function hasRoomBesideDialog ({ viewportWidth, dialogWidth, cardWidth, gutter })
  // → (viewportWidth - dialogWidth) / 2 >= cardWidth + gutter
```

- **Why a function of widths rather than a media query.** The dialog's width has two regimes —
  viewport-bound below ~704 px, content-bound above — and its content-bound value is expressed in
  `rem`. The root font-size is 16 px *today* (browser-measured); this site already drives other
  sizes off viewport-relative clamps, so a future `html { font-size: clamp(...) }` would move the
  real threshold while a hard-coded `1100px` media query kept passing. A predicate over measured
  numbers cannot go stale that way; a breakpoint can, silently, with a green suite.
- **Why it is testable without a browser.** It takes four numbers. `node --test` asserts it at the
  three browser-measured geometries (1280/739.59/384/20 → `false`; 1512/… → `false`;
  1600/… → `true`) and at the regime boundary. The *measurement* lives in `js/chat.js` — one
  `getBoundingClientRect()` on `#projectDialog .project-dialog__panel`, read when a chip is tapped
  and on resize — and the *decision* lives in the pure leaf. Identical decide/draw split to
  ADR-0015 §4.2 and ADR-0016 §3.1, for the identical reason: the half that needs a compositor
  should be the half with no logic in it.
- **A browser journey confirms the consequence once** — when the predicate says `true` the two
  boxes do not overlap, and when it says `false` the dialog is the element at the overlap point.
  Confirming, not carrying: ADR-0015 §11.6's rule stands.

### 2.5 Decision 2.5 — one new reducer event, `open-beside`

A project chip is a visitor asking to talk *about the thing they are looking at*. Neither existing
event expresses that:

- `open-text` / `open-voice` → `modal` from every stage (`js/chat-stage.js:53-55`), which covers the
  project dialog with the chat's own backdrop. Correct on a phone, wrong on a desktop.
- `project-open` does not fire, because the store's `project` was written *before* the chat opened —
  tapping a chip writes nothing new, so no change event exists to react to.

So: **`open-beside`**, added to `CHAT_STAGE_EVENTS`, with one row and one new `ctx` key.

| event ↓ / from → | `closed` | `modal` | `docked` | `minimized` |
|---|---|---|---|---|
| `open-beside` | `R` | `R` | `R` | `R` |

where `R = ctx.roomBeside ? 'docked' : 'modal'`.

- **`closed` is NOT absorbing for this one event, and that is deliberate.** ADR-0015 §4.3 note 2
  makes `closed` absorbing for *site* events, so a visitor who never opened the chat cannot acquire
  a dock by navigating. `open-beside` is not a site event — it is a visitor tapping a button that
  says "talk to the assistant". Opening is exactly what it is for.
- **`ctx.wide` is untouched.** It still means "≥ 768 px" and still governs the yield events
  (`js/chat.js:1586-1590` feeds it from `matchMedia`). `roomBeside` is a second, independent key,
  because the two questions are different: `wide` asks whether a card fits the viewport, `roomBeside`
  asks whether it fits *beside a specific dialog*. Folding them into one key would mean the yield
  events started consulting the project dialog's geometry, which they have no business knowing.
- **`!roomBeside` → `modal`, not `minimized`.** This is the clause the plan gets backwards with
  "else pill". DERIVED from §2.1 and §2.2: at 1085 a pill sits **below** `.project-dialog`'s
  backdrop, so it is both unreadable (72% alpha plus a 16 px blur over it) and — the clause that
  does not depend on the alpha — **untappable**, because the backdrop is above it in the stack. So
  "else pill" on a phone produces a live conversation the visitor can neither read nor reach:
  strictly worse than no feature. `modal` at 1105 covers the dialog with the chat's own backdrop,
  the store keeps `project` set (so the model keeps the context), and closing the chat reveals the
  project dialog again, still open, unchanged.
- It arrives **with its caller**, because `test/chat-stage-wiring.test.mjs:460-494` asserts every
  member of `CHAT_STAGE_EVENTS` is reachable from `js/chat.js`. Adding the name without the chip
  turns that test red, which is the correct outcome.

### 2.6 Decision 2.6 — `stageChrome` gains one optional parameter

`stageChrome('docked')` returns `moveFocus: 'none'` (`js/chat-stage.js:151-160`), and ADR-0015 §4.4
argues that hard: *"entering `docked` or `minimized` must not move focus… stealing focus back into
the chat is the keyboard equivalent of the modal that this milestone removes."*

That argument is about a **yield**. `open-beside` is a **request**: the visitor tapped "talk about
this" and the composer (or the mic) is what they asked for. Leaving focus in the project dialog
means a keyboard visitor taps the chip and nothing is reachable without hunting.

So focus depends on *how* the stage was entered, not only on *which* stage it is:

```js
export function stageChrome (stage, opts)   // opts = { requested?: boolean }, default false
```

`stageChrome('docked', { requested: true })` returns `moveFocus: 'composer'`; every other cell is
unchanged, and the default argument reproduces today's table byte for byte.

**Why widen the function rather than move focus in `js/chat.js`.** ADR-0015 §4.2 exists so the
entire a11y contract is assertable as the output of a pure function in a repo with no jsdom. A
single case handled in imperative glue is the one cell of the table nothing checks — and it is the
cell most likely to be wrong, because it is the exception. Widening keeps the contract as data and
costs one optional parameter. This is additive under ADR-0015's header grant.

---

## 3. Decision — `open_project` / `close_project`, on both paths

### 3.1 The declarations: a SHARED enum, not two equal ones

MEASURED, and this is the lesson M2 paid for: `navigate_to_section` is declared **twice**
(`docker/chat/app/providers.py:147-163` and `docker/chat/app/live_gemini.py:69-98`), the two enums
drifted, the voice model could not emit `labs` for ~four months, and the fix was
`docker/chat/tests/test_guide_tool_contract.py` asserting the two declarations are the **same set**
and that the set is what the frontend resolves.

For the project tools, do the cheaper version of that fix **before** the drift:

- One module-level tuple in a new pure leaf, `docker/chat/app/project_refs.py`, computed once at
  import from the already-loaded knowledge pack. Both `providers.chat_tools()` and
  `live_gemini._LIVE_TOOLS` import it. Equality is then true by construction, not by test.
- **The registry is already derived, which the plan treats as new work.** MEASURED:
  `data/chat-knowledge/projects.json` is **generated** from `data/projects.json` by
  `scripts/build-chat-knowledge.mjs:312` (`buildProjects`), and the build's idempotence on committed
  source is **project invariant #15**, pinned by `test/chat-knowledge-build.test.mjs`. Verified by
  reading both files: **13 ids, identical, in the same order** — `team-tactics`,
  `ai-assistant-chatbot`, `monday-rover`, `gvp`, `apptio`, `jumpcloud`, `instant-ink`, `att`, `miu`,
  `sunrise`, `campus-party`, `5d-agency`, `early`. So the server's enum *is* the frontend's registry,
  by construction.
- The test that remains worth writing is the cross-file one, extending
  `test_guide_tool_contract.py` (generalise its `_nav_enum` to `_tool_enum(source, tool, arg)`):
  **the declared project enum equals the ids in `data/projects.json`.** The failure mode it catches
  is a content edit that adds a card without rebuilding the pack — a JSON edit by someone who never
  touched code, which is exactly the class
  `test/site-state-producer-matches-validator.test.mjs` was written for.

**Why an enum at all, rather than a free string.** On the text path the model already has the full
roster in `<project_index>` (every id, every name, a one-liner), so an enum is belt-and-braces. On
the **voice** path it is the only thing that works: §4.2 measures that the live instruction truncates
the knowledge blob at 5,900 of 19,074 chars, cutting `<project_index>` mid-`monday-rover`, so **the
voice model today cannot enumerate the projects at all.** A 13-value enum (~150 static chars) is the
cheapest place it can learn the roster, and it is in the cached/static part of the request.

### 3.2 Resolution stays on the frontend, in `js/project-ref.js`

Same leaf-plus-registry shape as `js/section-names.js`, with **one deliberate difference**: the
section registry is a hard-coded constant (`SECTION_IDS`, `js/section-names.js:20`) because the site
has three sections and they are structural; the project registry is **content loaded at runtime**
(`projectDetailsById`, populated per card in `createProjectCard`, `js/projects.js:298-311`). So:

```js
// js/project-ref.js — pure. The registry is INJECTED, never imported.
export function resolveProjectRef (raw, registry)
  // registry: Iterable<{ id, title }>
  // → { id, title } | { error: 'unknown_project', received }
```

- Normalise before matching, for the reason ADR-0015 §9.2 measured on sections: the shipped chain
  compared bytes, so `"Portfolio"` — the capitalisation a model naturally uses — fell to
  `unknown_section`. Match in order: exact id → case/whitespace-insensitive id → exact title →
  case/whitespace-insensitive title → `unknown_project`. **No fuzzy substring or edit-distance
  matching.** This is the same ruling as ADR-0015 §5.2's rejection of `inferPromisedNavigation`, one
  layer down: a loose match on 13 titles that include *"AI assistant & chatbot"* and *"Generative
  Video Platform"* will pick the wrong card for *"tell me about the video one"*, and opening the
  wrong project is a worse failure than reporting that you could not find it — the model can ask.
- **Own properties only.** MEASURED, `js/section-names.js:56-62` carries a comment recording the
  defect this prevents: a bare `REGISTRY[key]` reaches the prototype chain, so
  `resolve('constructor')` returned `{ id: [Function: Object] }` — neither a target nor an error —
  and the router threw a `TypeError` out of the tool call. The project resolver has the same hazard
  and the same one-line fix.
- The registry is injected rather than imported because `js/projects.js` owns it and a pure leaf that
  reaches into a module-level `Map` is not pure. It also makes the resolver testable with a
  three-row fixture instead of a DOM.

### 3.3 `js/projects.js` must thread `origin` — the same defect M2 fixed in `js/contact.js`

MEASURED: `js/projects.js:235` is `setProject({ id, title: data.title || '' }, { origin: 'visitor' })`
and `:152` is `setProject(null, { origin: 'visitor' })` — **the origin is hard-coded**. MEASURED
contrast: `js/contact.js:86` is `setContactOpen(true, { origin: (opts && opts.origin) || 'visitor' })`
with a comment at `:74` naming the reason — *"the AGENT opens this dialog too, through
open_contact_form"*.

`open_project` makes exactly that true of the project dialog. So `openDialog(id)` grows an `opts`,
`closeDialog()` grows an `opts`, and `js/projects.js` exports the agent entry point, mirroring
`js/navigation.js`'s `requestNavigation(raw, { origin })` which `js/chat.js:1682` already calls:

```js
export function requestProjectOpen (ref, opts)    // → { id, title } | { error, received }
export function requestProjectClose (opts)
```

**Why this is not optional.** ADR-0015 §3.3: an agent-caused change and a visitor-caused change are
**byte-identical in the state**, so `origin` is the only discriminator, and §7.1 uses it to decide
whether a live session gets a context note. With the origin hard-coded to `visitor`, the agent's own
`open_project` would push a note telling the model about the change **it just made and already
received in the tool result** — the double-notify the whole dedupe exists to prevent. The bug is
invisible: the state is right, the UI is right, and the model hears itself twice.

### 3.4 What the tool result echoes, under invariant #21

Read back from the store, **never** constructed from the argument (ADR-0015 §5.1, invariant #21):

```js
{ result: 'opened_project', projectId: <from the store>, projectTitle: <from the store>, siteState }
{ error: 'unknown_project',     received: <raw>,  siteState }
{ error: 'project_did_not_open', projectId: <resolved>, siteState }
{ result: 'closed_project',  siteState }
{ error: 'project_did_not_close', siteState }
```

- **`siteState` is `getSiteStateForWire()`**, the same five flat keys the request carries, for the
  reason `js/chat.js:1731-1733` already states: the whole state travels, so the model never has to
  remember where the visitor was to know where they still are.
- **The "did not apply" clause is genuinely reachable here, measured.** `openDialog` returns early
  when `projectDetailsById.get(id)` misses (`js/projects.js:160-161`), and that Map is populated per
  card in `createProjectCard` — which runs only after `await loadProjects('/data/projects.json')`
  resolves (`js/app.js:257-264`) and **never at all** when the fetch fails (`loadProjects` returns
  `{ playground: [], portfolio: [], loadFailed: true }`, `js/projects.js:71`). So a voice visitor on
  a slow connection can ask for a project in the first second and, without the read-back, be told
  it opened. This is the same shape as the one case ADR-0015 found for `open_contact_form`
  (`js/chat.js:1724-1728`): the dialog is a no-op until its init has run.
- **`close_project` when nothing is open is a SUCCESS, not an error.** This is the one thing an
  implementer will get wrong, so it is stated: invariant #21 is about whether the **state** the
  result asserts is true, not about whether work was done. `project === null` after
  `close_project()` is true, so `{ result: 'closed_project' }` is honest. Contrast the no-op hash
  write (ADR-0015 §5.1/§9.4), which reported success for a state that had **not** been reached —
  the opposite case. Returning an error for an already-satisfied postcondition teaches the model to
  retry or to apologise to the visitor for nothing.
- **No `await`, no timeout.** ADR-0015 §5.1 specified a 250 ms wait; `navigateToSection` dropped it
  because `requestNavigation` calls `applySection` directly and the store is settled on return
  (`js/chat.js:1692-1696`). `requestProjectOpen` has the same property: `setProject` is called
  synchronously inside `openDialog` and the store notifies synchronously (`js/site-state.js:97-105`).
  Adding a wait here would be cargo-culting the mechanism without its cause.

### 3.5 The dropped-`toolResponse` trap holds by construction — pin it anyway

MEASURED (ADR-0015 §9.3 c1): `open_contact_form` used to reach `closePanel({ immediate: true })`
**synchronously**, which reached `snapClose → stopVoice → ws = null` before control returned to the
send guard at `js/chat-live.js:1036`, so the `toolResponse` was **dropped entirely** and the model
waited forever on a function response.

`open_project` goes through the store, the store feeds the reducer, and the reducer's `project-open`
row cannot produce `closed` from any non-closed stage (`js/chat-stage.js:69-73`). So the property
holds **by construction** — which is exactly when it is cheapest to lose to an innocent refactor.
The pin already exists: `test/site-events-never-stop-voice.test.mjs` is invariant #20's `stopVoice`
spy. Extend it with the two new agent-origin writers rather than writing a new file.

### 3.6 Tool descriptions, and the prompt version

- Both declarations describe `open_project` as *"show the visitor one project's detail card"* and
  name the companion: a model that opens cards and never closes them leaves a stack of nothing (only
  one dialog element exists, so the second open replaces the first — but the model does not know
  that, and will narrate as if it does). Say so in the description, where a wrong answer is
  recoverable, per ADR-0015 §5.2's residual.
- **Prompt version → `1.6.0`, not `1.7.0`.** MEASURED: `docker/chat/prompts/system-prompt.md:1` is
  `<!-- prompt-version: 1.5.0 -->`. §11.3 is the argument.
- The static tool guidance goes in the **system prompt**, which is free: MEASURED, the prompt is
  7,248 chars (~1,812 tokens) and `test_cache_prefix.py:91-99` counts it **inside** the cacheable
  prefix, so static guidance is paid for once and served from cache thereafter.

---

## 4. Decision — `siteState.projectId` and the knowledge pack: two paths, two answers

The plan says *"backend attaches the knowledge-pack summary"* as if it were one change. MEASURED, it
is two, and on one of the two paths the thing the plan describes **cannot work as written**.

### 4.1 The text path — a pinned retrieval match, cache-neutral, with measured headroom

MEASURED structure of `serialize_context_xml` (`docker/chat/app/knowledge_context.py:545-660`) and
of the blob it produces on the committed pack:

| section | offset | static or dynamic |
|---|---|---|
| `<bio>` | 16 – 4,684 | static |
| `<role_index>` | 4,690 – 5,420 | static |
| `<project_index>` | 5,433 – 7,246 | static |
| `<faq>` | 7,262 – 12,267 | static |
| `<retrieval_tags>` | 12,273 | **dynamic** |
| `<relevant_roles>` | 12,306 | **dynamic** |
| `<relevant_projects>` | 14,956 | **dynamic** |

MEASURED over `test_cache_prefix.py`'s own seven questions: identical prefix **12,289 chars of blob
(~3,072 tokens) + 7,248 chars of system prompt**, total **~4,884 cacheable tokens** against the
4,096-token minimum the test pins — a margin of ~788 tokens. Worst-case dynamic remainder **7,547
chars (~1,886 tokens)**, i.e. **8.48 turns/min** against the test's 5.0 floor, leaving **~1,314
tokens of headroom.**

MEASURED cost of one project's detail block (`_compact_project`): **722–1,673 chars** (mean 1,137),
i.e. **~180–420 tokens**. Its one-liner in `<project_index>` is 151–169 chars and is **already in
the cached prefix for all thirteen projects**, at zero marginal cost.

**Decision 4.1.** The open project is pinned into the **existing dynamic `<relevant_projects>`**
section, not into a new one.

- **Marginal prompt cost: at most ~420 tokens, and zero bytes added to the cacheable prefix** —
  because that section is already outside it. 420 of 1,314 tokens of headroom. DERIVED by addition
  from the two measurements; do not re-measure it, redo the addition if the caps change.
- **The constraint that bit M2, restated because M4 is the next place to trip it.** A new line or
  section placed in `head` — before the first byte that varies — would **truncate the cacheable
  prefix to the system prompt alone (~1,812 tokens), under the 4,096 minimum, so caching would stop
  engaging entirely** and the measured ~2.8× throughput regression would return. Its symptom is not
  a wrong answer: correct replies, green tests, and only the 429 rate moves. The blob's head must
  stay **byte-identical across turns**, and the per-turn site fact must stay where
  `_with_site_state` already puts it — a human turn immediately before the visitor's newest message,
  i.e. **after `contents[0]`'s knowledge blob** (`docker/chat/app/main.py:236-270`, whose docstring
  is the post-mortem).
- **The seam: one additive key on the chain input dict.** `main.py` already calls
  `app.state.chain.ainvoke({"messages": lc_messages})` (`:949`); it becomes
  `{"messages": ..., "pinnedProjectId": ...}` and `providers._inject_retrieved` (`:170-190`) reads
  `inp.get('pinnedProjectId')` and forwards it to `build_context` as an explicit parameter.
  Consumers that do not read it ignore it — but the **mock path must thread it identically**, or the
  mock and the real chain answer differently and every mock-backed test becomes a statement about
  nothing.
- **An explicit parameter, NOT text appended to the retrieval query.** MEASURED why: `build_context`
  computes `tags = extract_tags(query)` and `query_norm` from one concatenated string
  (`knowledge_context.py:344-348`), and both feed **role** retrieval as well as project retrieval
  (`matched_roles = [r for r in roles_all if _is_relevant(r, tags, query_norm)]`, `:351`). Smuggling
  "Team Tactics" into the query would therefore change which **roles** are retrieved and would
  pollute `<retrieval_tags>`, which is rendered into the prompt verbatim (`:607`). A side effect on
  an unrelated section, caused by a parameter passed as prose.
- **The pin must not EVICT the question's own matches.** `max_projects` defaults to 3
  (`knowledge_context.py:19`). The pinned project is **prepended and the cap raised by one for that
  turn**, deduplicated by id. Otherwise a visitor asking about Apptio with the Team Tactics card
  open loses one of Apptio's three slots to a project they did not ask about.

### 4.2 The voice path — the plan's mechanism cannot work, MEASURED

MEASURED by running `build_live_system_instruction` on the committed pack and prompt:

```
live blob (empty query)                    19,074 chars
prompt_body (truncated at 7,200)            7,200 chars
reserve for voice_rules                       900 chars
budget_pack = 14,000 − 7,200 − 900          5,900 chars   ← the blob is truncated to this
resulting instruction                      13,988 chars (CHAT_LIVE_SYSTEM_MAX_CHARS default 14,000)
```

So the voice model receives **5,900 of 19,074 chars — 31% of the knowledge pack.** Cross-referencing
§4.1's offsets, the cut lands at 5,900:

- `<bio>` survives whole (4,668 chars — **79% of everything the voice model gets**);
- `<role_index>` survives;
- `<project_index>` is **cut mid-`monday-rover`**, the third project. Verified in the rendered tail:
  `…</p><p id="monday-rover">Monday Rover (Raspberry Pi) — Demonstrates Marwan&#x27;s practical…[truncated]`;
- `<faq>` (5,005 chars) is **entirely absent**;
- `<relevant_projects>` is **entirely absent**.

**DERIVED, and it is the finding that most changes M4's shape:** the plan's "backend attaches the
knowledge-pack summary" is unreachable on voice by any retrieval change, because the section that
would carry it is discarded before the model sees it. A pinned `<relevant_projects>` entry on the
live path is **dead bytes**. Worse, `build_live_system_instruction` calls `build_context('', '', pack)`
with an **empty query** (`:505`), so `<relevant_projects>` holds `projects_all[:2]` by fallback
regardless of what the visitor is looking at — the voice model's "relevant projects" are whichever
two rows happen to be first in the JSON.

**Decision 4.2 — on the voice path, the open project's grounding rides in the site-state reserve,
and it is one sentence.**

- MEASURED: `build_live_system_instruction` already takes `site_state_line` and already reserves its
  length **inside** the pack budget (`:510-514`) — `budget_pack = max(3500, max_total − len(prompt_body)
  − 900 − len(site_line))`, with a docstring recording why appending it afterwards silently eats the
  portfolio tail. Verified: a 92-char site line leaves the total at exactly 13,988, displacing 92
  chars of blob.
- So the server appends the project's **existing `one_liner`** — already capped at 100 chars by
  `_index_entry`'s `_truncate_text(str(one), 100)` (`:323-334`) — to the head, inside that reserve.
  **Cost: ≤ ~110 chars displaced from the already-truncated `<project_index>` tail.** A bounded,
  measurable trade of a roster entry the model is losing anyway for a detail about the card in front
  of the visitor.
- **A SEPARATE server-side function, not a change to `format_site_state_line`.** This is the
  load-bearing part. MEASURED: that line is rendered **twice, in two languages** —
  `docker/chat/app/site_state.py:83-122` into the instruction and `js/site-state-notes.js:34-62`
  into the live `clientContent` note — and `test/fixtures/site-state-lines.json` is a shared table
  both suites assert against, written *because* the two `navigate_to_section` enums drifted and cost
  four months. The browser **has no knowledge pack**, so a one-liner folded into that function would
  make the two renderers structurally unable to agree. Therefore:
  `project_grounding_line(project_id, pack) -> str`, server-only, in `project_refs.py`, called only
  where the server has the pack. `format_site_state_line` and the fixture table are **untouched**.

### 4.3 The residual, recorded with its number

Mid-session, when the visitor opens a different card during a live call, the model gets the §7 note
— **title only, no grounding** — because the note is minted in the browser. The three alternatives
and why they lose:

1. *Enrich the note in the relay.* MEASURED: there are three transports (`'live' | 'relay' |
   'direct_google'`, clamped in `docker/chat/app/turn_input.py` and recorded per turn), and
   browser-direct voice (ADR-0007) has no server in the path at all. Enriching in the relay gives
   the model different knowledge depending on which transport it got — a correctness property that
   varies by network topology.
2. *Send `data/projects.json`'s description from the browser.* That is FE marketing HTML, a second
   source of truth for "what is this project", against a pack that is **generated** from the same
   file but reframed (`buildProjects` adds `why_it_matters`, `relevance_tags`, `summary`).
3. *Mint a fresh session on every project change.* Reverses invariant #20.

So: **title only, mid-session, and that is the decision.** The real blocker is the 31% truncation,
which is not M4's defect and not M4's to fix — §12.5 files it with the numbers so the next person
does not re-measure them.

---

## 5. Decision — `micAttachPlan`

### 5.1 The plan's premise is half false, MEASURED

The plan: *"cold path attached the mic right after sending the greeting → `micAttachPlan`: cold +
assistant-speaks-first ⇒ attach after the first `turnComplete` (15 s fallback); warm ⇒ now."*

MEASURED, `js/chat-live.js:1351-1377` — **both branches do the same thing.** The warm branch is
`await attachMicrophoneInternal()` (`:1357`) and the cold branch is `await
attachMicrophoneInternal()` (`:1371`), each immediately after `sendGreetingClientContent`. What
actually differs between warm and cold is the greeting **text** (`GREETING_TEXT_WARM` vs
`GREETING_TEXT_COLD`, `:1339`), the follow-up nudge, and the error recovery. So *"warm ⇒ now"* is
not a change, and **warm/cold is the wrong discriminator.**

The right one is: **will a permission prompt appear?** MEASURED, `detectMicPermissionState()`
returns `'granted' | 'denied' | 'prompt' | 'unknown'` (`:474-488`), and `startVoice` collapses that
to two values — `perm === 'granted' ? 'warm' : 'cold'` (`:1326-1329`) — which **folds `denied` in
with `prompt`**. Those two need opposite treatment.

Two more MEASURED facts the plan omits, and both change the design:

- **The cold path has no follow-up nudge.** `:1000-1007` schedules it only when
  `sessionIntent === 'warm' && active && !userSpokeAfterGreeting`, with a comment saying cold
  sessions skip it *"because the visitor still needs to grant mic permission."* So today a visitor
  who takes eight seconds at the prompt lands in silence. **Deferring the attach makes that window
  longer**, so a fix that only moves the attach makes the symptom it was aimed at worse.
- **A 60-second sweep already exists.** `VOICE_SESSION_IDLE_NO_MIC_MS = 60 * 1000` (`:30`) closes an
  open-but-mic-less session. So the plan's 15 s fallback must be **asserted** shorter than it, not
  coincidentally shorter, or a future tuning edit makes the fallback unreachable.

### 5.2 The seam

```js
// js/mic-attach-plan.js — pure. No navigator, no getUserMedia, no timers.
export function micAttachPlan ({ permission, assistantSpeaksFirst })
// → { attach: 'now' | 'after-first-turn', deferFallbackMs: number, nudgeAfterAttach: boolean }
```

| `permission` | `assistantSpeaksFirst` | `attach` | why |
|---|---|---|---|
| `'granted'` | either | `now` | No prompt will appear, so there is nothing to defer. |
| `'denied'` | either | `now` | **The case the plan's two-state framing loses.** No prompt appears here either; `getUserMedia` rejects immediately. Deferring a *certain* failure by a turn delays the error message the visitor needs in order to fix it in their browser settings. |
| `'prompt'` / `'unknown'` | `true` | `after-first-turn` | A modal permission sheet over a speaking assistant. Defer until the greeting's first `turnComplete`. |
| `'prompt'` / `'unknown'` | `false` | `now` | A second voice session in the same conversation does not greet (MEASURED: `shouldGreet = !conversationGreeted`, `:1338`), so nothing is speaking and there is nothing to interrupt. |

- `deferFallbackMs: 15000` when deferred, `0` otherwise. **A test asserts `deferFallbackMs <
  VOICE_SESSION_IDLE_NO_MIC_MS`** by reading the constant's effect from the outside, the discipline
  `turn_input.py` uses under invariant #17 — so the bound and its test cannot be changed in one
  edit.
- `nudgeAfterAttach: true` in the deferred case, which is how §5.1's silence gap gets closed in the
  same change rather than widened by it.

**Testable without a microphone** because it takes a permission **string** and a boolean — four rows
in `node --test`, no device, no `navigator`, no stub. That is the whole point of making it a function
of the permission state rather than a function of the device.

### 5.3 The wiring requirements, which are where this actually breaks

Three, each with a measured reason:

1. **`stopVoiceInternal` must clear the deferred-attach timer.** MEASURED: it already clears
   `noMicIdleTimer` and `warmFollowupTimer` (`:644-653`, called from the stop path). Without this,
   a visitor who ends the call during the greeting gets a microphone permission prompt for a session
   that no longer exists — a browser-level dialog with no context, which is the worst possible
   version of this feature.
2. **The deferred attach must re-check the session.** MEASURED: `attachMicrophoneInternal` already
   opens with `if (!voiceSessionOpen || !setupDone) throw new Error('voice session not ready')`
   (`:1199`), so the guard exists. The new requirement is that its throw is **handled** on the
   deferred path — it is currently reached synchronously inside a `try` that sets a user-facing
   status (`:1370-1377`), and a timer callback has no such wrapper.
3. **Both triggers must be idempotent.** The first `turnComplete` and the 15 s fallback can both
   fire; `attachMicrophoneInternal` opens with `if (active) return` (`:1198`), which covers the
   second one *after* a successful attach but not two in flight. One boolean, named, not inferred.

---

## 6. Decision — the launcher chip: which fields, and its relation to `restore` and `minimize`

### 6.1 The plan's symptom is REFUTED as measured; the real defect is sharper

The plan: *"Dead top-bar input while a chat is active."* **Browser-measured** at 1280×900, 1512×950
and 420×820:

| stage | `#agentNodeInput.readOnly` | `elementFromPoint` at its own centre |
|---|---|---|
| `closed` | `false` | the input |
| `modal` | `true` | `.chat-dialog__scroll` — covered by the chat's own backdrop |
| `docked` | **`false`** | **the input** |
| `minimized` | **`false`** | **the input** |

So in both yielded stages the input is editable **and** hit-testable, and in `modal` it is behind
the chat's own backdrop and therefore not reachable to be dead. The symptom as stated does not
reproduce.

**It reproduces non-deterministically, and that is its own finding.** MEASURED: `readOnly` has **two
writers with different rules** — `js/chat.js:1072` sets it `true` on open, and
`js/agent-node.js:292-299` (`syncInputReadOnly`) sets it `false` whenever
`matchMedia('(pointer: fine)')` matches, called from `refreshPlaceholderUi` on every placeholder
rotation and section sync. Whichever ran last wins. That is ADR-0015 §3.2's one-writer discipline
violated at the DOM layer, and it is why the plan's symptom is a real memory for somebody and
unreproducible here. §12.3 files it.

**The real defect the chip fixes is different and worse.** MEASURED, `js/chat.js:1476-1478`:

```js
agentInput.addEventListener('click', () => {
  if (state.history.length > 0 && !isOpen()) { openPanel() }
})
```

`isOpen()` is `!dialog.hidden` (`js/chat.js:394`), and `stageChrome` keeps `dialogHidden: false` for
**both** yielded stages (`js/chat-stage.js:151-160`). So with a conversation minimised, clicking the
launcher does **nothing at all**, and typing into it promotes to `modal` and silently appends to a
transcript the visitor cannot see. This is the identical trap `test/chat-stage-wiring.test.mjs:300-312`
closed for `openPanel` — *"openPanel early-returns when isOpen(), and isOpen() is `!dialog.hidden`
— which stageChrome says is FALSE for docked and minimized"* — surviving one call site further on,
because the fix was applied to the symptom rather than to the predicate.

### 6.2 The chip

- **Fields read: `chatStage` and `voiceActive`. Nothing else.** `chatStage !== 'closed'` → a
  conversation exists, render the chip; `voiceActive` → the label is *"Voice live"* rather than
  *"Assistant active"*. It reads them through `subscribe` (`js/site-state.js:80-86`), which already
  calls back immediately with `change === null`, so the chip's first render needs no separate
  bootstrap. It does **not** read `section`, `project` or `contactOpen`: a chip whose label depended
  on where the visitor was would change under them as they browsed, which is the opposite of
  "your conversation is still here".
- **It must read `chatStage`, not `isOpen()`** — §6.1 is the whole argument, and the predicate is
  the thing that was wrong both times.
- **Its activation dispatches `restore`, which already has a caller.** MEASURED: `js/chat.js:1604`
  dispatches `restore` on a click anywhere in the minimised pill that is not an action or the close
  X. So the chip is `restore`'s **second** caller, not its first — the plan reads as if the chip
  introduces the behaviour.
- **`restore`, not `open-text`, and this is the safety property.** ADR-0015 §4.3 note 1:
  `restore` from `closed` returns `closed` (`js/chat-stage.js:60-61`) — *"`restore` cannot resurrect
  a closed conversation… Keeping them distinct is what lets M4's launcher 'Assistant active' chip be
  a `restore` without accidentally becoming a cold open."* M2 wrote that sentence for this chip.
  It means a chip that is wrongly visible — a subscribe leak, a stale render — **cannot** open a
  conversation; it can only fail to restore one. The chip gets to be unconditional because the
  reducer already refuses the dangerous case.
- **`+ focuses`:** the chip restores to `modal`, and `stageChrome('modal').moveFocus === 'composer'`
  already (`js/chat-stage.js:134-141`). No new focus rule.

### 6.3 `minimize` — the exemption M2 put on the record, closed here

MEASURED, `test/chat-stage-wiring.test.mjs:474-479`:

> `minimize` — the reducer handles it and §4.3 specifies it, but M2 ships NO minimise affordance:
> the X closes, and the launcher restores. It is wired in M4 with the launcher work. Listed here so
> the gap is a decision on the record rather than an oversight that looks identical.

M4 closes it: a **minimise control in the docked card's header**, beside the existing close X,
dispatching `minimize` with `origin: 'visitor'`. Then `NOT_YET_AFFORDED` becomes `[]` and that test
asserts what it claims to assert for all thirteen — fourteen — events.

**Why the affordance belongs here and not in M2.** Without a restore path that is visible from
outside the panel, a minimise button is a trapdoor: at the minimised size the panel renders as the
header alone — a title and a close X (`css/chat.css:2397-2418`, and the browser measurement recorded
at `test/chat-stage-wiring.test.mjs:507-510`) — so a visitor whose only visible control says "close"
can lose a live call to a mis-tap. The chip is the way back, so minimise and the chip ship together
or neither ships. One slice, two affordances.

---

## 7. Decision — selection offers and project chips: where "only on a tap" is ENFORCED

The plan's parenthesis — *"quote goes to the model only on an explicit tap"* — is a privacy claim.
A privacy claim held up by a convention is held up by whoever edits the call site next. Four seams,
each closing a different route out.

MEASURED starting point: there is **no selection handling in this repo at all**
(`grep -rn 'getSelection\|selectionchange\|mouseup' js/` → nothing). This is new ground, not an
extension of something.

### 7.1 The decision is a pure leaf that cannot send

```js
// js/selection-offer.js — pure. No DOM query, no network, no analytics.
export function selectionOffer ({ text, withinRegion, maxChars })
// → { show: boolean, quote: string, reason: 'ok' | 'too-short' | 'too-long' | 'region-not-allowed' }
```

It decides and clamps. It has no `send`, no `fetch`, no `trackEvent` — the same construction
ADR-0015 §7.3 used for the live notifier, where the module note states the rule outright: *"THIS
MODULE HAS NO WAY TO END A VOICE SESSION… It is given a `send`, and nothing else."* Here it is given
**nothing**, because it needs nothing.

`maxChars` is a module-private constant asserted from the outside as behaviour. A quote is a
**value**, not an identity, so under invariant #17's rule — *clamp values, reject identities* — it
truncates rather than drops.

### 7.2 The only sink is the composer, and the composer does not send

MEASURED, the two existing entry points:

- `openPanelWithDraft(text)` (`js/chat.js:1453-1466`) sets `composerInput.value = body`, autosizes,
  and **does not submit**.
- `openPanelWithMessage(text, source)` (`js/chat.js:1447-1452`) **submits**.

**The contract: a selection offer may call `openPanelWithDraft` and may NEVER call
`openPanelWithMessage`.** The quote lands in a visible, editable composer, and it reaches the
network only when the visitor presses send — the same gesture that sends anything else they type.
That *is* the explicit tap, and it is a tap on the thing whose whole meaning is "send this".

**Pinned by a source assertion, deliberately.** The failure mode is a one-word edit at a call site:
`openPanelWithDraft` → `openPanelWithMessage`, which no behavioural test on the pure leaf can see
and which a diff review reads as a synonym. So: no module that imports `js/selection-offer.js` may
reference `openPanelWithMessage`. Same technique and same justification as
`test/site-state.test.mjs`'s grep for `site-chat-collapse` (ADR-0015 §3.6 — *"the failure mode is a
leftover emitter, which no behavioural test on the new store can see"*) and
`test/frontend-no-secrets.test.mjs`.

**And it is forward-safe for the right reason.** MEASURED, `js/chat-payload-hash.js:11-12` and the
comment at `js/chat.js:1150-1156`: `buildChatRequest` is the **single serializer**, because the
`x-amz-content-sha256` digest must cover the exact bytes sent. So there is exactly one place a quote
could reach the wire, and it is the one the composer's submit path already goes through. A second
egress route cannot be added without breaking the CloudFront + OAC front door with a 403 — the
architecture is doing the enforcement, and this records why.

### 7.3 The quote never enters an analytics param

`selection_assistant_offer` and `selection_assistant_chip` carry **`{ chars: <bucketed length>,
section }`** and nothing else. No quote, no selector, no page offset.

MEASURED why this is a hard rule and not a preference: `recordEvent` buffers `params` with **no
filtering** (`js/site-events.js:89-99`), and `buildEventRecord` **clamps** each param to 240 chars
rather than dropping it (`aws/src/common/events-shared.js:21,42`) — so a quote passed as a param is
**persisted for 120 days** (`EVENT_TTL_DAYS = 120`, `:28`) in the events table, beside a hashed IP
(`ipHash`) and a sessionId, through a **public unauthenticated** route, with no consent gate. The
product question is "do people use this?", and a **bucketed length** answers it. The text does not
answer anything the length does not.

### 7.4 The selection SOURCE is restricted by construction, not by browser behaviour

`selectionOffer` refuses unless the selection is inside an allowlisted content region
(`#portfolioContent`, `#labsContent`, `#projectDialog .project-dialog__description`, `main p`), and
the caller passes the region it resolved — the allowlist is checked in the pure leaf, so the refusal
is testable.

**Why an allowlist and not "selections in form fields don't happen".** `window.getSelection()
.toString()` returns `''` for a selection inside a `<textarea>` in Chrome and **returns the selected
text in Firefox**. DERIVED: a rule that relies on the browser not reporting it is a rule that holds
in one browser. The field in question is the contact form's `message` textarea — **the visitor's own
words, addressed to the owner, not site content** — and offering to feed those to a model is the one
version of this feature that would be a genuine incident. The allowlist is the enforcement; the
browser difference is why it cannot be left implicit.

### 7.5 Project chips are not a privacy sink, and they are `open-beside`'s caller

The three chips (*Summarize · Tell me more · Just talk about it*) carry **no visitor text** — a
project id from the registry and a canned prompt from a fixed table. They are `open-beside`'s caller
(§2.5), and they must live **inside `#projectDialog`**, because browser-measured (§2.2) that is the
only place a tap can land while a project card is up.

One consequence worth stating: the chips' canned prompts go through `openPanelWithMessage` — they
**are** submissions, and that is correct, because the text is ours, not the visitor's. The rule in
§7.2 is scoped to the selection module for exactly that reason, and the source assertion must be
scoped the same way or it will fail on the chips.

---

## 8. Decision — the admin "Assistant" tab, `assistant-usage?days=`, and ADR-0015 §6.4's ruling

ADR-0015 §6.4 filed this forward verbatim: *"If any admin rollup ever keys a histogram or facet by
`section` or `projectId`, that is a new cardinality sink and needs its own slice… M4 wants exactly
this for `projectId`. Filed forward; do not build it in M2."* Here is the ruling.

### 8.1 It is ALLOWED, because refusing is a deferral rather than a policy

Invariant #17's own residual says cardinality *"cannot be [bounded] at this sink — cardinality is a
cross-request property the sink cannot see, so it is read-side work by construction."* That makes
the read side the **only** place it can be done. "Don't facet by it" is not a bound; it is
postponement. So: allowed, and the read side carries a structural bound — a different one for each
value, because the two values differ in a way that matters.

### 8.2 `section` — CLOSED, not merely bounded

The facet is keyed by **`SECTION_IDS` ∪ `{'other'}`** — a fixed four-value key space today. An
unrecognised section increments `other`.

- Why this works: MEASURED, `siteState.section` is contractually a member of `SECTION_IDS`
  (`js/section-names.js:20`), and the server deliberately passes an unknown-but-pattern-valid
  section through verbatim for availability (ADR-0015 §6.2 — rejecting one would turn an IA rename
  into a site-wide chat outage). So the **wire** is open-ended on purpose while the **facet** need
  not be.
- Precedent, MEASURED: `transport` is the one cardinality case invariant #17 records as **closed**,
  *"because its key space is a fixed 3-value set."* Same move, same shape, costs one `Set` lookup.
- A new section appears in the facet only when `SECTION_IDS` changes, which is a code edit under
  review.

### 8.3 `projectId` — bounded by a REGISTRY, not by top-N alone

The facet is keyed by `projectId` **only for ids present in the committed registry**; everything
else collapses into one `unrecognised` bucket with a count. Key space: **13 + 1** today.

Two reasons it cannot be closed the way `section` is:

1. The registry has 13 members and grows with **content** edits, not code edits (`data/projects.json`
   is edited by whoever adds a card). A hard-coded enum in the rollup would need editing with every
   new project, and would be forgotten.
2. **It arrives from a public unauthenticated route and the only bound is a charset.** MEASURED:
   `projectId` is validated as `^[A-Za-z0-9._-]{1,64}$` (`docker/chat/app/site_state.py:46`) and
   persisted on every turn (`main.py:865-871`, ADR-0015 §6.4). So an anonymous caller can mint
   10,000 distinct 64-char ids and, with an unbounded read side, **own 10,000 rows of the owner's
   dashboard**. That is invariant #17's named failure. **The attack surface is identical for
   `section`** — an attacker does not go through `js/site-state.js:193-197`'s producer, it posts
   directly, and `^[a-z][a-z0-9-]{0,31}$` admits plenty of distinct values. What differs is the
   bound *available*: `section`'s legitimate key space is a three-value **code-owned** enum, so
   collapsing everything else into `other` costs nothing and loses nothing (§8.2); `projectId`'s
   legitimate key space is **content-owned and grows**, so the only bound that does not lose real
   data is to read the registry.

The registry is the right bound rather than top-N because it is **derived and already pinned**:
`data/chat-knowledge/projects.json` is generated from `data/projects.json`
(`scripts/build-chat-knowledge.mjs:312`) under invariant #15, so the rollup and the tool enum (§3.1)
read the same list and cannot disagree. Top-N would hide an attack behind "the long tail"; a
registry names it.

### 8.4 The counter that the existing test cannot see — MEASURED, and it is the trap

`test/chat-admin-histogram-keys.test.mjs` pins ADR-0020 §5 A7b: every caller-keyed counter in
`aws/src/contact-admin.js` must start from `Object.create(null)`, because `h[k] = (h[k] || 0) + 1`
on a plain `{}` finds an inherited `Object.prototype` function for `k = 'toString'` — truthy — so
`function + 1` concatenates and a **string** lands where the dashboard renders a number. Verified by
running it: the bucket becomes `'function toString() { [native code] }1'`, and `'__proto__'` is
silently dropped instead.

MEASURED: that test matches counters **by name** —
`const COUNTER_NAMES = 'errorsByCode|transports|toolHistogram'` (`:33`) — and asserts a count of
**six** known ones (`:43`). So a new `bySection` / `byProject` counter is **invisible to it**. M4's
slice must add the new names to `COUNTER_NAMES` and raise `KNOWN_COUNTER_COUNT`, or the test passes
while the new facets carry exactly the defect it exists to prevent. This is the kind of gap that
ships green.

### 8.5 The route

`GET /api/contact/admin/assistant-usage?days=` on the **contact** HttpApi, over an SDK-free core.

- **`days` is a VALUE, so clamp — to `[1, 90]`.** MEASURED precedent: `parseLimit` clamps to
  `[1, 100]` with a default (`aws/src/contact-admin.js:62-66`). And the cost is structural, not
  stylistic: MEASURED, the events table is read **one day at a time** via
  `queryDayWith(runQuery, { tableName, listPk: 'EVENT', day, … })` with `maxItems` defaulting to
  **50,000 rows per day** (`aws/src/common/report-queries-core.js`), already wired at
  `contact-admin.js:204`. So `days=365` is 365 GSI queries in one Lambda invocation. Clamp it at the
  parse, state the per-day cap, and the worst case is 90 × 50,000 — which is itself worth a
  `maxItems` override on this route rather than inheriting the report's.
- **Zero IAM and zero environment change.** MEASURED: the admin function already holds
  `DynamoDBReadPolicy` on `SiteEventsTable` (`aws/template.yaml:404-405`) and `SITE_EVENTS_TABLE` is
  a **Globals** environment variable (`:51`), consumed at `contact-admin.js:184,204,834`. The plan
  treats the route as new infrastructure; it is a route, a throttle and handler wiring.
- **It needs a `RouteSettings` entry.** MEASURED: admin routes carry per-route throttles of
  burst 5 / rate 2 against a default of burst 10 / rate 5 (`aws/template.yaml:67-107`), with the
  comment *"slows brute-force attempts against `x-admin-key`"* — and MEASURED, `/admin/smoke` and
  `/admin/session/{id}` have `Events` entries with **no** `RouteSettings`, so they already inherit
  the looser default. Add the new route's throttle, and note the two that are missing (§12.4).
- **Core at `aws/src/admin/assistant-usage-core.js`:** pure, SDK-free, injected query runner.
  MEASURED precedents: `aws/src/common/session-timeline-core.js` and `report-queries-core.js` are
  exactly that shape, and `test/contact-core-no-aws-sdk.test.mjs` pins the install-free `node --test`
  floor that makes it necessary — a test that imported the handler would pass locally off a cached
  `aws/src/node_modules` and fail CI on a clean checkout.
- **"Re-visualised, not extended" is self-contradicting** (§11.7): a new route over a new data
  source is an extension, and pricing it as a re-skin is how the slice count comes out at 11.

---

## 9. Scope, invariants, and the security clearance

### 9.1 One clause on invariant #22 — no new number for the layering rule

#22 (*"While the assistant is yielded, the site remains operable"*,
`docs/tdd/project-invariants.md:1192-1207`) already owns this claim, and
`test/chat-stage-layering.test.mjs` is already its pin. Add one clause rather than a number, the
same move ADR-0016 §8 made on #6:

> **and a yielded stage paints below every dialog the visitor can interact with; only the `modal`
> stage may paint above them.**

Argued from the failure mode: the regression is **one integer in one CSS declaration**, invisible in
a diff, and browser-measured once already (the pill over the contact form). The clause's pin is the
file that found it, extended with `modal > project` (§2.3).

### 9.2 Proposed invariant **#23** — the selection privacy rule

Next free number is **#23**, MEASURED: the file runs #1 … #22.

> **#23 — Visitor-selected text reaches neither the model nor any sink without an explicit visitor
> submission, and never reaches an analytics parameter at all.** `[app]` A selection offer may place
> a quote in the composer (visible, editable, unsent) and nothing else; the quote reaches the
> network only through the composer's own submit path, and selection analytics carry a bucketed
> length, never the text.
> *Pins:* (1) a source assertion that no module importing `js/selection-offer.js` references
> `openPanelWithMessage`; (2) a behavioural assertion that the offer path performs no `fetch` and no
> `trackEvent` carrying the quote.

**Promoted against this file's own bar, with the argument stated**, the way #22 was. The file
reserves itself for durability / safety / secret / correctness defects. This is a **privacy**
defect, closest to the secret family — and ADR-0020 / invariant #17 already established that
bounding what a public sink persists is invariant-grade. The regression is one word at a call site
or one added analytics param; it is invisible in review; and it ships the visitor's own words into a
120-day store keyed to a hashed IP. **If the navigator disagrees it stays a feature test with the
same two assertions** — the assertions are not negotiable either way.

### 9.3 Decision — M4 writes **flat in `js/`**, and ADR-0018 relocates M2, M3 and M4 together

The plan's navigator decision #3 is *"M5: address-first. M2/M4/M6 write their files directly at
their `js/lib`, `js/components`, `app/models|voice|assistant` and `aws/src/admin` addresses."*

MEASURED: `js/` has **no** `lib/` and **no** `components/` subdirectory; `docker/chat/app/` has no
`models/`, `voice/` or `assistant/`; `aws/src/` has no `admin/`. Every file M2 and M3 shipped is
flat. So **address-first is already false** — it was decided when M2 was unbuilt, and two milestones
have landed flat since.

**Decision:** M4 writes flat, like its neighbours, with one exception —
`aws/src/admin/assistant-usage-core.js`, because `aws/src/` has no sibling to be inconsistent with
and the plan names that address for the SDK-free cores specifically. Reason for the rest: M4 alone
at the new addresses gives `test/component-boundaries.test.mjs` a single component to fence while
every M4 import path differs from its neighbours' — the worst of both. One relocation of three
milestones is cheaper, and it is reviewable as one diff where a mixed tree is reviewable as none.
**ADR-0018 inherits the relocation**, and it is now a relocation, not a fence. That is a real cost
M5 did not have at plan time and the navigator should see it stated.

### 9.4 `SECURITY_GLOB` clearance — scoped, four files

MEASURED (`.claude/tdd.config:68`): `SECURITY_GLOB` blocks edits in **every** phase, including `off`,
unless `SECURITY_REVIEW=1` is set for the edit. M4 touches four matched paths. **This §9.4 is the
architect review those edits require**, and it clears exactly:

1. **`docker/chat/app/live_gemini.py`** — add the two `FunctionDeclaration`s to `_LIVE_TOOLS`,
   importing the shared project-id tuple from `app/project_refs.py`.
2. **`docker/chat/app/main.py`** — add the top-level `language` field to `ChatRequest` (§12.2); pass
   `pinnedProjectId` on the chain input (§4.1); pass the project-grounding line into
   `build_live_system_instruction` (§4.2); persist only the **validated model's dump**, per ADR-0015
   §6.4 and the precedent at `main.py:853`.
3. **`aws/src/contact-admin.js`** — add the `assistant-usage` route branch, wiring only; the rollup
   lives in the SDK-free core (§8.5), and every new counter starts from `Object.create(null)`
   (§8.4).
4. **`aws/template.yaml`** — one `Events` entry and one `RouteSettings` throttle for the new route.
   **No IAM change and no new environment variable** (§8.5) — if a slice proposes either, it is
   outside this clearance.

It clears **nothing else** on those files. In particular it does **not** clear touching
`CHAT_LIVE_SYSTEM_MAX_CHARS` or the `900` reserve (§12.5 is a separate decision), and it does not
clear `aws/src/events-ingress*.js`.

`aws/src/common/daily-report.js` — the §12.1 fix — is **not** on `SECURITY_GLOB` and needs no
clearance; the config comment says so explicitly (`:65`, *"Routine reporting logic (daily-report,
session-timeline, *-shared) … stay unblocked"*).

---

## 10. Decision — the new analytics events: which are sinks

| event | status | key space | verdict |
|---|---|---|---|
| `chat_open{surface}` | **already ships** — `js/chat.js:1662`, `{ surface: 'event', chatSessionId }` | `surface`: fixed set | Not new. Additive surfaces only. |
| `chat_live_start{source,intent}` | **event already ships** with `{}` — `js/chat-live.js:1274` | `intent ∈ {warm, cold}`; `source` fixed | Additive params. Bounded. |
| `chat_mic_permission{state}` | new | the Permissions API's own 4 values + `unknown` (`js/chat-live.js:474-488`) | Bounded by construction. **Not** a privacy sink — a permission state is not a device identifier. |
| `chat_tool_call{tool,ok,source}` | new | 5 tool names + `unknown_tool`; `source ∈ {text, voice}` | **The one easy new sink — see below.** |
| `project_assistant_chip` | new name | carries a project id | **Not a new sink.** `project_interaction{project_id}` already ships (`js/analytics.js:54-60`) with exactly that. §8.3's read-side bound covers both. |
| `selection_assistant_offer` / `…_chip` | new | `{ chars: bucketed, section }` | **The only privacy-shaped ones.** §7.3. |
| `chat_launcher_resume` | new | fixed name, no variable params | Not a sink. |

**`chat_tool_call{tool}` is the one that needs a rule, and it is one line.** The FE must **never**
pass the model's `name` through. MEASURED: `applyVoiceToolCall` already returns
`{ error: 'unknown_tool: ${name}' }` for an unrecognised name (`js/chat.js:1738`), so the frontend
already knows when a name is off-contract — it must emit the literal `unknown_tool`, not the model's
string, or the event's key space becomes **model-controlled**. Precedent, MEASURED in invariant #17:
`sanitize_tool_calls` **drops** an entry whose `name` is unusable rather than coercing it,
*"because coercing it (`str(['a','b'])`) would mint a permanent dashboard row for a tool that never
ran."* Same failure, one layer up.

**And one cross-cutting rule, because the plan's naming invites breaking it: variability goes in
`params`, never in the event NAME.** MEASURED: the daily report builds `byEvent` with **no top-N**
(`aws/src/common/daily-report.js:43-45`) while `bySection` and `topPages` both go through
`topN(…, 12)` (`:46-47`). So an event family like `chat_tool_call_open_project` would grow the daily
report's table without bound — **in an emailed artefact**. §12.1 and §12.2 are the pre-existing half
of this.

---

## 11. Verification of the plan's M4 text

The plan's §0 baseline was stale for M1 and its M3 text was wrong in seven places. M4's is wrong or
stale in **eleven**. Each is cited; each changes a slice.

**11.1 — "Assistant unreachable with a project open · project dialog `z 1100` > chat `1095` · chat
`1105` / pill `1106`."** Symptom **CONFIRMED** (browser-measured, §2.2). Cause **INCOMPLETE**: the
chat is unreachable *before* z-order matters, because `.project-dialog`'s `inset: 0` backdrop
covers every launcher (header 1010, spaceman 1020) — `elementFromPoint` over `#agentNode` returns
the project dialog. "chat `1105`" **CORRECT, for the modal stage only.** "pill `1106`"
**REFUTED** — it reverses `test/chat-stage-layering.test.mjs` and reinstates the browser-measured
regression its own comment records (§2.3).

**11.2 — "≥1100 px the dialog shifts left beside the docked card (`hasRoomBesideDialog`), else
pill."** Threshold **WRONG**: centred needs **≥ ~1547 px**, shifted needs **≥ ~1184 px**, and at
1512 px the two still overlap by ~18 px (browser-measured, §2.4). "The dialog shifts left"
**REJECTED** — it inverts invariant #22 by making the site the thing that yields. "Else pill"
**REFUTED** — at 1085 a pill is below the project dialog's backdrop, so on a phone it is a
conversation the visitor cannot see at all (§2.5).

**11.3 — "prompt `1.7.0`."** **WRONG.** MEASURED: `docker/chat/prompts/system-prompt.md:1` is
`1.5.0`, and no other file in the repo mentions a prompt version. `1.7.0` is the sandbox's number
from a different bump sequence. It matters because `promptVersion` is a **real admin filter facet**
(`parseChatFilters`, `aws/src/contact-admin.js:432-446`) persisted on every turn and surfaced as
`app.state.prompt_version` (`docker/chat/app/main.py:460,561`) — so minting `1.7.0` fabricates two
prompt revisions that never existed and makes any before/after comparison across them meaningless.
**→ `1.6.0`.**

**11.4 — "No project context or offers · state carried only a title."** **STALE.** M2 shipped
`project {id, title}` in the store (`js/site-state.js:38,121-134`) and `projectId` + `projectTitle`
on the wire (`:192-211`), validated server-side (`docker/chat/app/site_state.py:61-67`). Already
done, not to do.

**11.5 — "backend attaches the knowledge-pack summary."** **Affordable on text, structurally
impossible on voice as written.** MEASURED: the live instruction truncates the 19,074-char blob to
**5,900 chars**; `<relevant_projects>` begins at offset 14,956 and `<faq>` at 7,262, so neither
reaches the voice model, and `<project_index>` is cut mid-`monday-rover`. §4.2 is the replacement
and §12.5 files the underlying condition.

**11.6 — "Mic prompt cuts the greeting · cold path attached the mic right after sending the greeting
· warm ⇒ now."** **HALF REFUTED.** MEASURED: both branches `await attachMicrophoneInternal()`
immediately after the greeting (`js/chat-live.js:1357` warm, `:1371` cold) — so "warm ⇒ now" is not
a change and warm/cold is the wrong discriminator. Three omissions, each design-changing: `denied`
is folded in with `prompt` by `startVoice`'s mapping (`:1328`); the cold path schedules **no**
follow-up nudge (`:1000-1007`), so deferring the attach **lengthens** an existing silence gap; and
the 15 s fallback must be asserted shorter than the existing `VOICE_SESSION_IDLE_NO_MIC_MS = 60000`
sweep (`:30`). §5 is the replacement.

**11.7 — "Dead top-bar input while a chat is active."** **REFUTED as measured.** Browser-measured at
three viewports: `readOnly: false` and hit-testable in both yielded stages; `readOnly: true` in
`modal` but behind the chat's own backdrop. The real defect is sharper — `agentInput`'s click handler
is gated on `!isOpen()` and `isOpen()` is `!dialog.hidden`, true for both yielded stages, so clicking
the launcher with a conversation minimised does nothing (§6.1). And the plan's symptom is
*reproducible for some people* because `readOnly` has two writers with different rules (§12.3).

**11.8 — "Admin re-visualised, not extended."** **SELF-CONTRADICTING** in the same sentence, which
proposes a new route over a new data source. Three tabs exist today (`admin/index.html:60-62`).
Pricing an extension as a re-skin is how the slice count came out at 11 (§8.5).

**11.9 — "New tracking: `chat_open{surface}`, `chat_live_start{source,intent}`, …"** **Two of the
seven already ship.** `chat_open` at `js/chat.js:1662`; `chat_live_start` at `js/chat-live.js:1274`.
Both are additive-param changes, not new events (§10).

**11.10 — "Adds `scripts/qa/admin-dashboard-preview.py` (screenshot checks of the dashboard)."**
**WRONG STACK, and "checks" has no oracle.** MEASURED: the repo's only browser harness is
`scripts/qa/cdp.mjs` — Node, **zero dependencies**, a raw CDP client whose `page.send(method, params)`
reaches any CDP method (`:99`), with `Page.enable` already called (`:111`). So
`Page.captureScreenshot` is **reachable in one line — and is not implemented, has no helper, and
has no caller.** Stated precisely because it was reported to me the other way round: ADR-0016 §10.2
says *"there is no screenshot capability — MEASURED, `grep -n captureScreenshot scripts/qa/` returns
nothing"*, and **that is still true**; what is narrow about it is only that the generic `page.send`
channel reaches the method. Nothing landed. A **Python** preview script would be a second browser stack in
a repo that declares no dependencies in either language (`package.json` declares neither
`dependencies` nor `devDependencies`). Two further problems: there is **no image comparison and no
baseline storage anywhere in the repo**, so "screenshot checks" has nothing to check against — a
screenshot is an **artefact for a human**, not an assertion, and ADR-0016 §10.2's deeper objection
(no committed baselines, no pixel tolerance, no determinism) survives the browser landing intact;
and MEASURED, the dashboard renders
nothing without an admin key typed into `sessionStorage` (`js/admin.js:125,990-991`), so the harness
needs a credential, which `test/frontend-no-secrets.test.mjs` and `SECURITY_GLOB` exist to keep out
of the tree. **→ `scripts/qa/admin-dashboard-preview.mjs` on the existing client, key from the
environment with no default, and scoped as a screenshot *artefact* plus a handful of
`elementFromPoint`/`textContent` assertions — never a pixel diff.**

**11.11 — the execution-order line, "M0 → M1 → M5 → M2 → (M3 ∥ M4) → …".** **M5 did not run before
M2.** `.claude/state/progress.md` records M1, M2 and M3 complete and M5 unstarted, and MEASURED there
is no `js/lib/`, no `js/components/`, no `aws/src/admin/` and no `app/models|voice|assistant/`. So the
address-first premise is void and §9.3 is the ruling.

---

## 12. Collateral drift found while verifying — filed for the loop, not fixed here

**12.1 — five caller-keyed counters in the daily report start from a plain `{}`, and the report is
emailed.** MEASURED: `aws/src/common/daily-report.js:24-26` (`byEventCounts`, `bySectionCounts`,
`byPageCounts`), `:60` (`errorsByCode`), `:109` (`byStatus`). `POST /api/events` is **public and
unauthenticated** and `event` is caller-supplied, clamped only to 80 chars
(`aws/src/common/events-shared.js:20,50`). So an event named `toString` makes the count the string
`'function toString() { [native code] }1'` — **verified by running it** — and `__proto__` drops the
bucket silently. This is ADR-0020 §5 A7b's defect in the second of the two files that had it, and
`test/chat-admin-histogram-keys.test.mjs` **cannot see it**: it reads `contact-admin.js` only
(`ADMIN_SOURCE`, `:28`) and matches by counter name (`:33`). **Not** on `SECURITY_GLOB`, so this
fix needs no clearance — the config says so at `.claude/tdd.config:65` (§9.4).

**12.2 — `byEvent` has no top-N while its two siblings do.** MEASURED:
`aws/src/common/daily-report.js:43-45` sorts and emits **every** event name; `:46-47` pass
`bySection` and `topPages` through `topN(…, 12)`. Event-name cardinality is therefore unbounded in
an emailed artefact. Pair it with §12.1 and with §10's naming rule.

**12.3 — `#agentNodeInput.readOnly` has two writers with different rules.** MEASURED:
`js/chat.js:1072` sets it `true` on open and `:1023,1654` reset it from
`launcherReadOnlyForDevice()`; `js/agent-node.js:292-299` sets it `false` whenever
`(pointer: fine)` matches, from `refreshPlaceholderUi` on every placeholder rotation. Last writer
wins, so the behaviour depends on timing. This is ADR-0015 §3.2's one-writer discipline violated at
the DOM layer and it is why §11.7's symptom is a real memory and an unreproducible bug. Related, and
the one M4 must fix because it is in the chip's path: `agentInput`'s click handler uses `!isOpen()`
where it means `chatStage === 'closed'` (`js/chat.js:1476-1478`, §6.1).

**12.4 — `project.hidden` in `data/projects.json` is dead data, and `CLAUDE.md` documents it as
live.** MEASURED: nothing reads it — `createProjectCard` (`js/projects.js:292`) ignores it and
`loadProjects` (`:46-72`) does not filter — and browser-measured, **all nine portfolio cards render,
including the four marked `"hidden": true`** (`miu`, `sunrise`, `campus-party`, `5d-agency`).
`CLAUDE.md` describes `data/projects.json` as *"project cards with `id`, `title`, `description`,
`image`, `link`, `hidden` flag."* Either honour it or delete it — and if it is ever honoured,
`open_project` silently loses four ids unless the tool enum (§3.1) is derived from the same filter.
Also MEASURED in the same area: `/api/contact/admin/smoke` and `/api/contact/admin/session/{id}`
have `Events` entries with **no** `RouteSettings` throttle (`aws/template.yaml`), so they inherit
the looser public default the admin block exists to tighten.

**12.5 — the voice path sees 31% of the knowledge pack, and `<bio>` is 79% of what survives.**
MEASURED (§4.2): 5,900 of 19,074 chars; `<faq>` (5,005 chars) and `<relevant_projects>` never arrive;
`<project_index>` is cut at the third project; `<bio>` alone is 4,668 chars. Not M4's defect and
**not M4's to fix** — but every claim M4 makes about voice grounding is downstream of it, and
`build_live_system_instruction` calling `build_context('', '', pack)` with an empty query
(`knowledge_context.py:503`) means the voice model's "relevant projects" are whichever two rows are
first in the JSON. The two levers are `CHAT_LIVE_SYSTEM_MAX_CHARS` (default 14,000, capped at
32,000) and `_compact_bio`'s output size. Neither is on `SECURITY_GLOB` —
`docker/chat/app/knowledge_context.py` is not matched — but both are budget arithmetic whose
failure mode raises nothing and logs nothing, which is the hardest kind to review. **Its own slice,
its own decision, with the numbers above as the starting point.**

**12.6 — `language` is still sent and still silently dropped; ADR-0015 §9.5 asked M4 to decide it.
Decision: wire it.** MEASURED: `js/chat.js:1285` sends `language: currentLanguage`, `ChatRequest`
declares no such field, and `grep -n language docker/chat/app/*.py` finds no reader — only the voice
rules' prose *"Reply in the visitor's language and switch languages with them"*
(`knowledge_context.py:528-529`). So the `<select>` at `index.html`'s `#chatLanguageSelect` is a
**visible control that does nothing**, which is worse than an absent one. Wire it as a **top-level
field on `ChatRequest`**, not a sixth `siteState` key — it is a request preference, not site state,
and keeping it out of the sub-model leaves §6.3's 512-byte addition untouched. It is an **enum key**
(the `<select>`'s option list), so under invariant #17 it **rejects** on shape
(`^[a-z]{2}(-[A-Za-z]{2})?$`) and **passes an unrecognised value through verbatim**, for the same
availability reason as `section` (ADR-0015 §6.2). It renders **text-path only**, from a separate
server-side function into the same `_with_site_state` human turn — the live model hears the
visitor's language directly, so `js/site-state-notes.js` and `test/fixtures/site-state-lines.json`
are untouched and cannot drift. **One slice, last, explicitly
droppable — and if the navigator drops it, the `<select>` is hidden in the same breath.**

---

## 13. Consequences

**Enabling.** Four new pure leaves — `hasRoomBesideDialog`, `resolveProjectRef`, `micAttachPlan`,
`selectionOffer` — plus one additive reducer row and one optional `stageChrome` parameter. Every one
is testable in `node --test` with numbers, strings and a three-row fixture: no DOM, no browser, no
microphone, no network. That matters in a repo with **zero test dependencies**, and it is what lets
the app and chat halves of M4 be built in parallel against §3.1's shared enum and §3.4's result
shapes. The browser journey confirms two consequences (the layering hit-test and the side-by-side
geometry) rather than carrying any contract — ADR-0015 §11.6's rule, unchanged.

**Costs and risks.**

- **One z-index moves.** `.chat-dialog` 1095 → 1105 raises the modal stage above `.project-dialog`.
  The yielded rule at 1085 is untouched, so `test/chat-stage-layering.test.mjs` gets **stronger**,
  not reversed. But the site now has two chat layers four digits apart and one of them is above
  everything; the file's comment must say which is which, because the next person to read "chat is
  1105" will apply it to the pill.
- **`stageChrome` is no longer a function of the stage alone.** The optional parameter is a crack in
  a contract whose value was that it had exactly one input. It is justified (§2.6) and it is
  default-safe, but a second optional parameter would not be — at that point the chrome is a
  function of history and the table stops being a table.
- **`js/chat.js` now measures layout.** One `getBoundingClientRect()` on another module's dialog
  panel. The pure predicate keeps the logic out, but the coupling is real: `js/chat.js` now knows
  `#projectDialog .project-dialog__panel` exists. The selector belongs in one named constant, not
  inline.
- **A new facet keyed by a persisted public value.** §8's registry bound is what keeps it inside
  invariant #17 rather than reopening it, and §8.4 is the test gap that would let it ship open.
- **The project tools make the agent a writer of two more store fields.** Invariant #20's spy must
  grow with them or the milestone's safety property quietly narrows to the fields M2 happened to
  know about.
- **The voice path's grounding is one sentence, and §12.5 is why.** M4 should not be read as having
  made the voice assistant project-aware; it has made it aware of the **title and one line**, which
  is all that fits.

**Migration notes.**

1. **No coordinated deploy, in either direction.** `language` and the project tools are additive:
   an older frontend sends no `language` and calls no project tool; an older server ignores
   `language` by pydantic's default `extra='ignore'` (MEASURED by exactly that mechanism in
   ADR-0015 §9.5) and simply never declares the project tools. The frontend and the chat host deploy
   independently and Amplify serves `main`'s HTML as-is (invariant #11), so this is load-bearing,
   not theoretical.
2. **The `.chat-dialog` z-index change is visual-only and self-contained.** No markup, no JS, no
   store field.
3. **`CHAT_STAGE_EVENTS` grows by one.** Any consumer that exhaustively switches on it must handle
   `open-beside`; MEASURED, the reducer's `default` branch already returns the stage unchanged
   (*"an unknown event is INERT, not fatal"*, `js/chat-stage.js:112-115`), so an unupdated consumer
   degrades to a no-op rather than throwing.
4. **`stageChrome`'s second parameter is optional and the default reproduces every shipped row.**
   No call site must change.

---

## 14. Recommended changes to M4's slice list

The plan says ~11 slices. With §11's eleven corrections the real shape is **16**, and the ordering
below is dependency- and risk-driven rather than feature-driven. The reasoning for the order is
stated after it, because the order is the part most likely to be ignored.

**Chat half (can run in parallel with the app half from slice 3 onward):**

1. `app/project_refs.py` — the shared project-id tuple derived from the loaded pack, plus
   `project_grounding_line`. **The cross-file test that the tuple equals `data/projects.json`'s ids**
   lands with it (§3.1).
2. The two `FunctionDeclaration`s in **both** `providers.py` and `live_gemini.py`, importing that
   tuple. Extend `test_guide_tool_contract.py`'s `_nav_enum` into `_tool_enum` and assert all three
   tools (§3.1). `SECURITY_REVIEW=1`, scope §9.4 items 1–2.
3. The pinned retrieval match: `pinnedProjectId` on the chain input → `_inject_retrieved` →
   `build_context`, prepended and the cap raised by one, deduplicated (§4.1). Pin it with a
   `test_cache_prefix.py` sibling asserting the **prefix is unchanged** and the dynamic remainder
   still clears 5.0 turns/min.
4. The voice grounding sentence inside the existing site-state reserve (§4.2), with a test that the
   instruction still lands ≤ `max_total` **with** a maximal site line **and** a maximal grounding
   line.
5. Prompt → **`1.6.0`**, with the static tool guidance for the two new tools (§3.6).

**App half:**

6. **`.chat-dialog` 1095 → 1105, and `chat-stage-layering.test.mjs` gains `modal > project`**
   (§2.3). One integer, one assertion, and it closes a live defect on its own.
7. `hasRoomBesideDialog` in `js/chat-stage.js` + its three measured geometries (§2.4).
8. `open-beside` in the reducer and the table, with `ctx.roomBeside` (§2.5).
9. `stageChrome(stage, { requested })` (§2.6).
10. `js/project-ref.js` — `resolveProjectRef`, registry injected, own-properties-only, no fuzzy
    matching (§3.2).
11. **`js/projects.js` threads `origin`** and exports `requestProjectOpen` / `requestProjectClose`
    (§3.3). Extend `test/site-events-never-stop-voice.test.mjs` with the two new writers in the same
    slice (§3.5).
12. The two tool handlers in `js/chat.js` with read-back results, including the
    `project_did_not_open` case and `close_project`-on-nothing-open as a **success** (§3.4).
13. The project chips inside `#projectDialog`, calling `open-beside` (§7.5).
14. `micAttachPlan` + its wiring, including `stopVoiceInternal` clearing the deferred timer and the
    nudge extended to the deferred case (§5).
15. **The launcher chip and the minimise control, together** — `NOT_YET_AFFORDED` becomes `[]`, and
    `agentInput`'s `!isOpen()` becomes `chatStage === 'closed'` (§6).
16. `js/selection-offer.js`, `openPanelWithDraft` as the only sink, the source assertion, and the
    bucketed-length events (§7). **Invariant #23 lands here or not at all.**

**Admin / analytics:**

17. `aws/src/admin/assistant-usage-core.js` (SDK-free, injected runner) + the route + the
    `RouteSettings` throttle + the `days` clamp (§8.5). **`test/chat-admin-histogram-keys.test.mjs`'s
    `COUNTER_NAMES` and `KNOWN_COUNTER_COUNT` grow in the same slice** (§8.4).
18. The Assistant tab in `admin/index.html` + `js/admin.js`.
19. `scripts/qa/admin-dashboard-preview.mjs` on the existing CDP client — artefact plus a few
    `elementFromPoint` assertions, **no pixel diff**, key from the environment (§11.10).
20. `language` wired (§12.6) — **last, explicitly droppable.**

**Why this order.**

- **Slice 6 first in the app half, like ADR-0015 §11.3 put the `stopVoice` spy first.** It is one
  integer, it closes a browser-measured defect that exists today independent of every other slice,
  and it means every later layering assertion is made against a correct stack. Done last, it would
  be done after thirteen slices had been built on top of the wrong one.
- **Slice 1 before slice 2, and 2 before everything that asserts a tool.** ADR-0015 §11.2 made the
  same call for the section enums: a voice assertion is meaningless while the model is working from
  a different vocabulary than the thing it is driving. Here the vocabulary is *shared* rather than
  duplicated, so the ordering is cheaper — but the shared constant has to exist before either
  declaration can import it.
- **Slice 11 before slice 12.** The origin threading is invisible until a tool uses it, and if the
  tool lands first the hard-coded `visitor` ships and the double-notify is live for one slice with
  every test green. The same mistake M2 made in `js/contact.js` and had to find in a critic pass.
- **Slice 3 and slice 4 are separate because their failure modes are separate.** 3 breaks the cache
  prefix (symptom: only the 429 rate moves). 4 silently truncates the knowledge pack (symptom: the
  voice agent forgets part of the portfolio). Neither symptom is visible in the other's test, and
  merging them would give one slice two invisible ways to fail.
- **Slice 15 is one slice, not two.** A minimise button without a visible restore path is a
  trapdoor (§6.3); shipping them in different slices means shipping the trapdoor.
- **Slice 17 before slice 18**, and the histogram-keys test grows **inside** 17. A facet built in
  one slice and bounded in the next is a facet that shipped unbounded, and §8.4 measures that the
  existing test would not have noticed.
- **Slice 20 last.** It is a real ruling (§12.6) and a real defect, but it is not in M4's acceptance
  bullets, and a milestone this size should have exactly one slice that can be dropped without
  renegotiating anything.

**And one decision for the navigator, zero slices:** §9.3 — M4 writes flat, and ADR-0018 becomes a
relocation of M2, M3 and M4 rather than a fence around addresses nobody wrote at. M4 is not *gated*
on that answer, but ADR-0018 should not discover it by surprise.

---

## 15. Addendum — 2026-10-23: M4 as built, and slice 20 dropped on measurement

Slices 1–19 of §14 are on `agent` (chat 1–5; app 6–16; admin 17–18 — slice 19's preview script
is folded into the browser checks recorded in each slice's commit). Built by two sessions; the
app half 6–12 first, then the chat half, 13–18 and this addendum after the handover.

**Slice 20 (`language`) is DROPPED, because §12.6's premise no longer holds — MEASURED:**

- `#chatLanguageSelect` **does not exist** in `index.html` any more, so there is no visible
  control that "does nothing" — the defect §12.6 set out to fix is already gone.
- With no select, `js/chat.js` falls back to `SUPPORTED_LANGS = ['en']`, so every request
  sends **`language: "en"`, always**.
- Wiring that as §12.6 specifies would put "reply in English" into every text turn and
  **override the model's current behaviour of replying in the language the visitor writes in**
  — a regression for every non-English visitor, delivered as a feature.

§12.6 made the slice "explicitly droppable — and if the navigator drops it, the `<select>` is
hidden in the same breath". The select is already gone, so dropping costs nothing further. The
residual is the field itself: still sent, still ignored by `ChatRequest` (`extra='ignore'`).
Removing it from `js/chat.js` is a cleanup, not a behaviour change, and is left for whoever next
touches the request builder. If a language control is ever reintroduced, §12.6's design (a
top-level field, shape-validated, rendered text-path only into the `_with_site_state` turn) is
still the right one.

**After the M4 critic pass (2026-10-23):**
- The Assistant tab's journey is now built from the events production *emits*. `chat_open`
  fires only for programmatic opens; the hero and header submit as `hero_chat_submit` and
  `header_chat_submit`; the footer is the `footer_open_chat` data-track; chips and selection
  offers open too. The first version counted only `chat_open` and passed a test whose fixture
  invented rows production never sends.
- **§8.3's registry-bounded `projectId` facet is NOT built.** No emitted event carries a
  `projectId` (`project_assistant_chip` is `{ chip, beside }`), so there is nothing to bound.
  Adding one is an FE event change that must come with its registry bound in the same slice.
- **§8.4's histogram-keys growth** is met behaviourally rather than by name: the new facets
  live in `aws/src/admin/assistant-usage-core.js`, outside the file that test scans, and
  `test/assistant-usage-core.test.mjs` feeds `toString` / `__proto__` through them.
- Two voice races fixed in `js/chat-live.js`:
  - one shared in-flight mic attach, so a manual tap plus the deferred attach no longer open
    two streams;
  - a mic allowed after hang-up is released at once.

**Stage-found defect, 2026-10-23 (peer session's live probe after the M4 deploy):**
- "Open the Apptio project" returned an **empty turn**: no text, no action, persisted as a
  normal turn. That happened on both the streaming and the non-streaming text paths.
- **Cause:** `main._actions_from_result` mapped only the three original tools, so the model's
  `open_project` / `close_project` calls were dropped.
- **Fixed:**
  - The tools now become `open-project` (carrying the registry-validated id) and
    `close-project` actions.
  - The frontend renders them as buttons; the tap is the visitor's.
  - `deriveReplyText` gives a tool-only turn a real line.
- **The contract test that would have caught it** is
  `test_every_declared_text_tool_becomes_an_action`: every tool the text path declares must
  map to an action. Voice was unaffected, because its tool calls go straight to the frontend
  handlers from slice 12.

**Measured on stage after the fix, 2026-10-23 (agent@65f763f, stream CodeSha256 `09ae9fcc…`):**
- `POST /api/chat` "Open the Apptio project" → 200 with
  `actions: [{ id: open-project, project: apptio, label: Open the project }]`. The id is the
  registry id, not the prose title.
- Through the real stage UI, with the real model:
  1. the reply rendered as "Tap below to open that project…" with the button;
  2. the tap opened the Apptio card;
  3. the chat yielded to `docked` beside it, with no console errors.
- **§3.2's "no fuzzy matching", measured, not just intended:** "Open the Blockchain Casino
  project" (no such project) produced a real apology naming the miss and offering real
  projects. It declined to guess rather than opening the wrong card, and it did not go silent
  the way the empty-turn bug had.

