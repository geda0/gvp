# ADR-0011 — IA merge: one projects-first "Work" showcase + inline experience section

Status: Accepted
Date: 2026-06-17
Supersedes: the Portfolio/Labs split established in `test/labs-restructure.test.mjs`
References: ADR-0010 (agent navigation/tour uses this section vocabulary)

## Context

The site currently has **two** top-level project pages routed by hash:

- `#portfolio` → `#portfolioContent` / `#portfolioProjects` (professional work, `goPortfolio`)
- `#labs` → `#labsContent` / `#labsProjects` (personal builds, `goLabs`; the page formerly
  known as `playground`)

with `#home` as the base. `js/section-names.js` resolves three buckets
(`home`/`portfolio`/`labs`, with `playground` → `labs`). `js/navigation.js` toggles the two
page containers. Project data is split in `data/projects.json` under `portfolio` (9) and
`playground` (4); `js/app.js` renders `data.portfolio` → `#portfolioProjects` and
`data.playground` → `#labsProjects`. The résumé is only a PDF link inside the Portfolio intro
(`resume/Marwan_Elgendy_Resume_public.pdf`).

The owner wants: (1) **one** projects-first "Work" section (drop the split); (2) an **inline**
experience/résumé section the agent can scroll to (PDF demoted to a quiet download); (3) the
agent guiding people to the work, never defaulting to the résumé (ADR-0010).

## Decision

### 1. Section vocabulary (the contract ADR-0010 navigates against)

Top-level sections collapse to:

```
home  ·  work  ·  experience  ·  contact
```

- **`work`** — the unified projects-first showcase (portfolio ∪ labs).
- **`experience`** — a new first-class **on-page** section: the career/experience timeline,
  with the résumé PDF as a quiet download link (not the lead).
- `contact` — unchanged contact surface (dialog).

### 2. IA section map (old → new)

| Old (route / DOM / data) | New |
|---|---|
| `#home` (base URL) | `#home` (base URL) — unchanged |
| `#portfolio` → `#portfolioContent`/`#portfolioProjects`, `goPortfolio` | **`#work`** → `#workContent`/`#workProjects`, `goWork` |
| `#labs` → `#labsContent`/`#labsProjects`, `goLabs` | folds into **`#work`** (no separate page/grid) |
| `#playground` (already redirected to `#labs`) | redirects to **`#work`** |
| résumé = PDF link in portfolio intro | **`#experience`** on-page section + quiet PDF download |
| `data.portfolio` (9) + `data.playground` (4) | one ordered render into `#workProjects` |

**Legacy hash bookmarks resolve sensibly** (keep, don't 404): `#portfolio`, `#labs`,
`#playground` all `history.replaceState` → `#work` then render Work. This mirrors the existing
`#playground` → `#labs` redirect pattern in `navigateByHash`.

### 3. `js/section-names.js` resolver

`normalizeSection` collapses the project buckets into one `work` bucket and adds `experience`:

```
'work' | 'portfolio' | 'labs' | 'playground'   → 'work'
'experience'                                    → 'experience'
'home' | anything-else                          → 'home'
```

This is the single resolver both navigation and chat (`js/chat.js` imports `normalizeSection`)
consult, so the agent's section ids, the nav, and the chip presets stay in one vocabulary.
(`contact` is a dialog, not a normalized page bucket — it has no `normalizeSection` entry; the
agent reaches it via the existing contact action, not via `navigate_to_section`.)

### 4. `index.html` sections

- Replace the two containers (`#portfolioContent`+`#labsContent`) with **one** `#workContent`
  holding **one** project grid `#workProjects`. The merged grid renders the combined,
  ordered project list (see §6). Keep `id="projectDialog"` and the card markup contract
  unchanged — `createProjectCard` and the project dialog are reused as-is.
- Add a new **`#experience`** section (its own top-level container, e.g. `#experienceContent`)
  with the career/experience content inline on the page. The résumé PDF link moves here as a
  quiet download (`<a href="resume/...pdf" download>` styling de-emphasized; keep
  `data-track="resume_click"`). This is the scroll target for `navigate_to_section('experience')`.
- **Nav links:** replace the `#portfolio` + `#labs` nav links with a single **Work** link
  (`id="workNav"`, `href="#work"`) and an **Experience** link (`id="experienceNav"`,
  `href="#experience"`). Keep `#homeNav`.
- The agent-node / hero / chat markup is untouched.

### 5. `js/navigation.js`

- `elements` map: `workNav`, `experienceNav`, `homeNav`, `workContent`, `workProjects`,
  `experienceContent`. Update `navRequired` accordingly (drop the portfolio/labs ids).
- `applySection`: branches become `home` / `work` / `experience`; `goPortfolio`+`goLabs`
  collapse into `goWork`; add `goExperience`. `setNavVisibility` toggles home/work/experience.
- `navigateByHash`: `#work` → Work; `#experience` → Experience; **`#portfolio`, `#labs`,
  `#playground` all `replaceState('#work')` → Work** (legacy bookmark redirect). Base → Home.
- `state.section` ∈ `{home, work, experience}`; `document.body.dataset.section` follows. Any FE
  reading `data-section` (e.g. spaceman context, chat chips) sees the new ids — those readers
  consult `normalizeSection`, so they ride the §3 change.

### 6. Project rendering in the unified Work showcase

- `loadProjects` already folds `playgroundBeta` into `playground`; extend the merge: return a
  single ordered `work` list = featured/labs leads + professional, **or** keep `portfolio` +
  `playground` arrays and concatenate at render. **Decision: concatenate in render order
  `[...featured, ...rest]`**, preserving the existing `featured` flag (team-tactics carries
  `featured: true`) so the featured card still leads. Keep both arrays in `projects.json` for
  now (data shape unchanged — lowest-risk); the *merge* happens in `loadProjects`/`app.js`,
  not in the data file. A later data-only consolidation can flatten to one array additively.
- `js/app.js`: one render call into `#workContent`/`#workProjects` with the concatenated list.
  Drop the second render call. The load-error path renders the error into `#workContent`
  (one section) instead of two.
- `createProjectCard`, the project dialog, `project-observer.js`, and `spaceman-position.js`
  selectors must point at `#workContent`/`#workProjects` (they currently reference both
  portfolio and labs grids) — flagged for the inner loop to update; not changed here.

## Consequences

- One projects-first page; the portfolio/labs split disappears from the UI, the router, the
  resolver, and the render path. The combined grid is the showcase.
- The experience/résumé becomes a navigable on-page destination — the seam ADR-0010's
  `navigate_to_section('experience')` and the tour's `experience` stop depend on. The PDF is a
  quiet download, not the default.
- Legacy `#portfolio` / `#labs` / `#playground` bookmarks keep working (redirect to `#work`),
  so external links and the agent's pre-merge enum (ADR-0010 §1 legacy tolerance) don't break.
- **This breaks the existing IA contract tests** — a migration cost, owned by the inner loop,
  not fixed in this ADR:
  - `test/labs-restructure.test.mjs` asserts the *split* (`#labsContent`, `#labsProjects`,
    `#labsNav`, `goLabs`, `data.playground[0]`, the playground-subsection-removed shape,
    `normalizeSection('labs')==='labs'`, `normalizeSection('portfolio')==='portfolio'`). After
    the merge these assertions describe the **old** world. The test must be rewritten to assert
    the merged world (`#workContent`/`#workProjects`/`#workNav`/`goWork`, `#experience` present,
    `normalizeSection('labs')==='work'`, legacy `#portfolio`/`#labs`/`#playground` → `#work`
    redirect, the featured card leads the merged grid). **Migration note: the test-writer
    re-specifies this first (red), then the implementer makes navigation/IA pass.**
  - `test/team-tactics-project.test.mjs` reads `data.playground` for the featured card. If §6
    keeps `data.playground` in the JSON (recommended), these assertions still hold; if a later
    slice flattens the data array, this test moves to the merged list. Keeping the data shape
    now means **this test does not change in the merge slice** — only the render path does.

### Env-guard / structural invariants — NOT touched

`test/frontend-api-url-env-guard.test.mjs` pins only the `gvp:contact-api-url` /
`gvp:chat-api-url` **meta tags** on `index.html` and `admin/index.html`. The IA merge changes
body markup and nav, **not** the meta tags. The env guard keeps passing as long as the meta
block is left intact — call this out to the implementer so a large `index.html` edit does not
disturb the meta tags (the 2026-06-04 staging-host-leak incident the guard exists for).

`test/frontend-no-secrets.test.mjs` and the project-render structure are unaffected by section
renames.

## Implementer clearance (SECURITY_GLOB)

None required. Every file this ADR touches — `index.html`, `js/section-names.js`,
`js/navigation.js`, `js/app.js`, `js/projects.js`, `js/project-observer.js`,
`js/spaceman-position.js`, `data/projects.json` — is **outside** the `SECURITY_GLOB`. No
`SECURITY_REVIEW` needed. (The chat-side changes that consume this vocabulary are cleared
separately in ADR-0010.)
