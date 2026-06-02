# First prompt — feature: add a new "presentation" project from `ddd.docx`

Paste the block below as your first message to Claude Code in the repo root.
You are the navigator. Before you start: drop the provided file at
**`intake/ddd.docx`** (source docs live in `intake/`).

> ⚠️ One design fork the orchestrator will likely ask about: does "a
> presentation" mean **(A)** a normal project entry tagged as a presentation that
> links out to / embeds an existing deck (reuses the current card + dialog
> renderer — assumed below), or **(B)** a brand-new in-page slide viewer? This
> prompt assumes **(A)**. If you want **(B)**, say so and the criteria expand.

---

You are the orchestrator. Follow the TDD Pairing Protocol in
`.claude/tdd/PROTOCOL.md` exactly. Set the phase file before every delegation,
delegate `red` to `test-writer` and `green` to `implementer`, and run
`tdd-critic` after ~3 cycles. The suite is `node --test`.

FEATURE
Add a new project to the portfolio: a **presentation**. Its content (title,
summary, body, tech, any links) comes from a Word document the user has placed at
`intake/ddd.docx`. The new project must slot into `data/projects.json` using the
existing schema and render through the current card + dialog code with no
renderer changes. Treat the docx as the *source of content only* — the testable
work is the pure transform and validation that turns extracted content into a
valid project record and inserts it safely.

EXISTING DATA MODEL (do not break it)
`data/projects.json` is `{ "playground": [...], "portfolio": [...] }`. Each
project object has: `id`, `title`, `cardDescription`, `description` (HTML string),
`image`, `imageAlt`, `link`, `linkText`, `tech` (non-empty string array),
`hidden` (bool), `role`, and sometimes `label`. New code should live in a new
ES-module under `js/` (e.g. `js/project-import.js`) exporting pure functions, and
be specced in `test/project-import.test.mjs` in the same `node:test` style as
`test/starfield-reduced-motion.test.mjs` (import the function, assert outputs —
no DOM, no network).

ACCEPTANCE CRITERIA (each is one or more red→green cycles, in order)
1. `slugifyProjectId(title)` returns a lowercase, hyphenated, URL-safe id:
   collapses whitespace and punctuation, trims leading/trailing hyphens, and is
   stable for the same input. e.g. `"DDD: A Presentation!"` → `"ddd-a-presentation"`.
2. `isValidProject(obj)` returns true only when every required field above is
   present with the right type and `tech` is a non-empty array and `description`
   is non-empty; returns false (and, via `assertValidProject`, throws with a
   message naming the missing/invalid field) otherwise.
3. `buildPresentationProject(input)` takes
   `{ title, summary, descriptionHtml, deckUrl, tech, image?, imageAlt? }` and
   returns a complete project object that satisfies `isValidProject`, with:
   `id` from `slugifyProjectId(title)`, `cardDescription = summary`,
   `description = descriptionHtml`, `link = deckUrl`,
   `linkText = "View presentation"`, `label = "Presentation"`,
   `kind = "presentation"`, `hidden = false`, sensible `image`/`imageAlt`/`role`
   defaults when omitted, and `tech` passed through (must be non-empty).
4. `addProjectToSection(collection, section, project)` returns a NEW collection
   (input not mutated) with `project` appended to `section` (`"playground"` or
   `"portfolio"`); throws on an unknown section, on a duplicate `id` anywhere in
   the collection, or on an invalid project; preserves existing entries and order.
5. Round-trip guard: building a presentation project and adding it to a copy of
   the real `data/projects.json` keeps the result valid — every entry still
   passes `isValidProject` and all ids remain unique.

FINAL INTEGRATION (after all criteria are green — this part is not TDD; pause for
my review because it edits real content)
a. Extract the text/structure from `intake/ddd.docx` and propose the concrete
   `buildPresentationProject` inputs (title, summary, descriptionHtml, deckUrl,
   tech). Show them to me and wait for approval.
b. On approval, insert the built record into `data/projects.json` (ask me whether
   it belongs in `playground` or `portfolio`), then run
   `npm run build:chat-knowledge` so the chat index picks it up, and confirm the
   node suite is green.

INSTRUCTIONS
1. First write/refresh `.claude/state/design-notes.md` from the above (goal +
   the 5 acceptance bullets + the open playground/portfolio question + the A/B
   fork).
2. Then begin the loop at criterion 1. One failing test at a time.
3. After each green, give me a one-line status. Ask me only for real decisions
   (the A/B fork, playground vs portfolio, anything in the docx that's ambiguous).
4. Do not edit tests to force green; do not hand-write `data/projects.json`
   content until the integration step, and not without my approval.
5. Stop when criteria 1–5 are green, the critic returns PASS, and I've approved
   the integration. Then summarize what shipped and which tests prove it.

Begin with criterion 1 now.
