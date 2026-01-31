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
| **idle**  | Hello! Welcome to my space! 👋 • I'm Marwan's digital companion. • Click around to explore! |
| **home**  | Back to home base! 🏠 • Feel free to explore anytime. • The stars are always shining here. |
| **playground** | These are Marwan's experimental projects! 🚀 • The Monday Rover was built with a Raspberry Pi. • GVP uses generative AI for video creation. |
| **portfolio** | Here's Marwan's professional journey! 💼 • From startups to IBM - quite a ride! • Software architecture is his specialty. |

### Garden theme

| State      | Messages |
|-----------|----------|
| **idle**  | Hello! Welcome to my world! 👋 • I'm Marwan's digital companion. • Strolling here with the summer rain. |
| **home**  | Back to my world! 🏠 • Feel free to explore anytime. • The sun and rain are lovely here. |
| **playground** | These are Marwan's experimental projects! 🌱 • The Monday Rover was built with a Raspberry Pi. • GVP uses generative AI for video creation. |
| **portfolio** | Here's Marwan's professional journey! 💼 • From startups to IBM - quite a ride! • Software architecture is his specialty. |

---

## 3. Resume-generated messages (added to cycle when resume loads)

Appended to the state message list in `_getMergedMessages()`.

### Portfolio (when state === 'portfolio')

- At Apptio (IBM) Marwan worked on TBM / IT Financial Management.
- Apptio (IBM): Data intensive SaaS platform
- At JumpCloud Marwan worked on Directory & Device Management.
- JumpCloud: Cloud-based directory as a  service
- At Instant Ink (HP) Marwan worked on Subscription & Financial services.
- Instant Ink (HP): Subscription service, print without worrying about ink
- At AT&T Marwan worked on Full-stack Developer.
- AT&T: TQL: SQL-like ticketing query language
- At Sunrise Resorts & Cruises Marwan worked on Datacenters & Infrastructure.
- Sunrise Resorts & Cruises: Datacenters, VPN, Asset Management Software

(First 5 experience entries only; 2 lines per entry: “At X Marwan worked on Y.” and “X: highlight”.)

### Playground (when state === 'playground')

- **One random skill line:** `Marwan builds with {skill}.`  
  Skills: Software Architecture, SaaS, Full-stack, Raspberry Pi, Generative AI, Video Platform, Data-intensive systems, Machine Learning.
- **One random project line** (from first 3 resume projects):  
  `{title} – {blurb}` or `{title}`  
  Examples: Monday Rover – Built with Raspberry Pi. • Generative Video Platform – A platform for generative storytelling. • Apptio (IBM) – Technology Business Management, IT Financial Management.

### Home / Idle (when state === 'home' or 'idle')

- Marwan's digital companion. Software architecture and full-stack development.

---

## 4. Project-in-view messages (context-aware)

When the user is on **Playground** or **Portfolio** and a project card is “most in view,” the agent has a **35% chance** per cycle to say a project-specific line instead of the next message in the list.  
Format: `That's {projectTitle} – {first 60 chars of description}…` or, if no description, `That's {projectTitle}.`

Titles and descriptions come from the **card’s data attributes**, which are set from `data/projects.json` (description is plain text, HTML stripped). So the exact text can match the following.

### Playground (no description in projects.json)

- That's Monday Rover (Raspberry Pi).
- That's Generative Video Platform.

### Portfolio (with description; first ~60 chars used)

- That's Apptio (an IBM company) – Technology Business Management (TBM) Software. Data intensive SaaS platform for IT Financial…
- That's Jumpcloud – A cloud-based directory service that allows users to manage their devices and…
- That's Instant Ink (HP) – A subscription service that allows users to print documents without having to…
- That's AT&T – I built TQL: ticketing query language, a SQL-like syntax based language to query…
- That's Master's in Computer Science – Machine Learning, Data Science, SDLC.…
- That's Sunrise Resorts & Cruises – I built Datacenters, Network Infrastructure, VPN, Asset Management Soft…
- That's Campus Party Milenio (Spain) – I got to share unique ideas and collaborate with innovators.…
- That's 5d-agency (SWI) – Web based & mobile Games! Augmented Reality, CMS, Joomla, Drupal, Unity 3D, Mobile…
- That's Early Startups – DDA Advertising: ddaadvertising.net OIG OS: Linux based embedded system. QREO: Web apps, Scien…

---

## 5. Fallback (no data)

If `spaceman.json` fails to load, defaults in `js/spaceman.js` (`DEFAULT_DATA`) are used:

- **idle:** Hello! Welcome!
- **playground:** Exploring projects...
- **portfolio:** Professional work...
- **home:** Back home!

---

## Summary counts (unique possible strings)

| Category              | Approx count |
|-----------------------|--------------|
| Reactions             | 6 (3 × 2 themes) |
| State messages (space)| 12 (3 per state × 4 states) |
| State messages (garden)| 12 |
| Resume portfolio      | 10 |
| Resume playground     | 8 skills + 3 project blurbs (one picked at build time) |
| Resume home/idle      | 1 (summary) |
| Project-in-view       | 2 (playground) + 9 (portfolio) = 11 templates |
| Fallback              | 4 |

The **cycle** for a given state = state messages (theme) + resume lines for that state. **Project-in-view** lines are chosen 35% of the time when context has a visible project; otherwise the next message in the cycle is used.
