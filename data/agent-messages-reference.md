# Spaceman agent – all possible messages

Sources: `data/spaceman.json`, `resume/resume.json`, `js/spaceman.js` (merged + project context).  
Reactions (hover / click / long idle) are fixed strings; state messages cycle and can be augmented by resume and by project-in-view.

---

## 1. Reactions (one-off)

Shown on hover, click, or after long idle. Theme-dependent.

| Trigger   | Space theme                         | Garden theme                        |
|----------|--------------------------------------|-------------------------------------|
| **hover**   | Oh, hello there! 👀                  | Oh, hello there! 👀                 |
| **click**   | Wheee! *jetpack boost*               | Wheee! *floating up*                |
| **longIdle**| Still here... floating in space... 🌌 | Still here... enjoying the garden... 🌿 |

---

## 2. State messages (cycle)

Shown in rotation. **Space theme** uses default `states`; **garden theme** uses `themeMessages.garden.states`.  
When `resume/resume.json` loads, extra lines are **appended** per state (see section 3).

### Space theme (default)

| State      | Messages |
|-----------|----------|
| **idle**  | Hello! Welcome to my space! 👋 • I'm Marwan's digital assistant. • Click around to explore! |
| **home**  | I love my space! 🏠 • Feel free to explore anytime. • The stars are always shining here. |
| **playground** | These are Marwan's experimental projects! 🚀 • The Monday Rover was built with a Raspberry Pi. • GVP uses generative AI for video creation. |
| **portfolio** | Here's Marwan's professional journey! 💼 • From startups to IBM — quite a ride! • Software architecture is his specialty. |

### Garden theme

| State      | Messages |
|-----------|----------|
| **idle**  | Hello! Welcome to my world! 👋 • I'm Marwan's digital assistant. • Strolling here in the summer rain. |
| **home**  | I love my space! 🏠 • Feel free to explore anytime. • The sun and rain are lovely here. |
| **playground** | These are Marwan's experimental projects! 🌱 • The Monday Rover was built with a Raspberry Pi. • GVP uses generative AI for video creation. |
| **portfolio** | Here's Marwan's professional journey! 💼 • From startups to IBM — quite a ride! • Software architecture is his specialty. |

---

## 3. Resume-generated messages (added to cycle when resume loads)

Appended to the state message list in `_getMergedMessages()`.

### Portfolio (when state === 'portfolio')

- At Apptio (IBM), Marwan worked on TBM / IT Financial Management.
- Apptio (IBM): A data-intensive SaaS platform
- At JumpCloud, Marwan worked on Directory & Device Management.
- JumpCloud: A cloud-based directory as a service
- At Instant Ink (HP), Marwan worked on Subscription & Financial Services.
- Instant Ink (HP): A subscription service — print without worrying about ink
- At AT&T, Marwan worked as a Full-stack Developer.
- AT&T: TQL — a SQL-like ticketing query language
- At Sunrise Resorts & Cruises, Marwan worked on Datacenters & Infrastructure.
- Sunrise Resorts & Cruises: Datacenters, VPNs, Asset Management Software

(First 5 experience entries only; 2 lines per entry: “At X, Marwan worked [on | as a] Y.” and “X: highlight”. AT&T uses `workVerb: "as a"`.)

### Playground (when state === 'playground')

- **One random skill line:** Normalized phrasing for some skills (e.g. “Marwan builds SaaS platforms.”, “Marwan builds full-stack applications.”, “Marwan builds video platforms.”, “Marwan builds data-intensive systems.”); others use “Marwan builds with {skill}.”
- **One random project line** (from first 3 resume projects): `{title} — {blurb}` (em dash).

### Home / Idle (when state === 'home' or 'idle')

- Marwan's digital assistant. Software architecture and full-stack development.

---

## 4. Project-in-view messages (context-aware)

When the user is on **Playground** or **Portfolio** and a project card is “most in view,” the agent has a **35% chance** per cycle to say a project-specific line instead of the next message in the list.

**Flow:** If the project has a `callout` in `resume/resume.json` (matched by `projectId`), that string is used. Otherwise the agent builds “That's {projectTitle} — {first 60 chars of description}…” from the card’s `data-project-*` attributes (from `data/projects.json`). All portfolio projects now have callouts, so fallback truncation is rarely used.

### Playground (no description in projects.json)

- That's Monday Rover (Raspberry Pi).
- That's Generative Video Platform.

### Portfolio (callouts from resume; em dash, third person where applicable)

- That's Apptio (an IBM company) — Technology Business Management, IT Financial Management, data-intensive SaaS.
- That's JumpCloud — a cloud-based directory service for managing users and devices.
- That's Instant Ink (HP) — A subscription service — print without worrying about ink.
- That's AT&T — He built TQL, a SQL-like ticketing query language.
- That's Master's in Computer Science — Machine Learning, Data Science, SDLC.
- That's Sunrise Resorts & Cruises — Datacenters, network infrastructure, VPNs, asset management software.
- That's Campus Party Milenio (Spain) — Sharing ideas and collaborating with innovators.
- That's 5d-agency (Switzerland) — web & mobile games, AR, CMS, Unity.
- That's early startups — embedded systems, Linux-based platforms, and advertising tech.

---

## 5. Fallback (no data)

If `spaceman.json` fails to load, defaults in `js/spaceman.js` (`DEFAULT_DATA`) are used:

- **idle:** Hello! Welcome!
- **playground:** Exploring projects...
- **portfolio:** Professional work...
- **home:** Back home!

---

## Message flow summary

1. **Load:** `spaceman.json` (state messages, reactions, theme overrides) and `resume/resume.json` (experience, skills, projects with optional callouts).
2. **Cycle:** For the current state and theme, merged list = state messages + resume-generated lines for that state. Message index advances only when a message from this list is shown (not when a project-in-view message is shown).
3. **Project-in-view:** When on Playground/Portfolio and a card is “most in view” (Intersection Observer), context = `{ projectId, projectTitle, projectDescription }`. 35% of the time the next message is the project line: resume `callout` if present, else “That's {title} — {truncated description}…”.
4. **Reactions:** Hover, click, and long-idle override the cycle briefly with theme-specific strings.

The **cycle** for a given state = state messages (theme) + resume lines for that state. **Project-in-view** lines are chosen 35% of the time when context has a visible project; otherwise the next message in the cycle is used.
