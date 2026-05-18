# CLAUDE.md

## Project Overview

Personal portfolio website for Marwan Elgendy ("The Computerist"). A static site with dual themes (Space and Garden), an animated interactive "Spaceman" character, and sections for Playground (experimental projects) and Portfolio (professional experience).

**Live site**: Static HTML/CSS/JS — no build step, no bundler, no framework.

## Tech Stack

- **HTML5** — single `index.html` entry point
- **CSS3** — CSS custom properties for theming, keyframe animations, responsive design
- **Vanilla JavaScript (ES6 modules)** — `<script type="module">` loading from `js/app.js`
- **Canvas API** — starfield (space theme) and snow (garden theme) animations
- **External CDN only**: Google Fonts (Source Serif 4, Source Sans 3), Google Analytics (gtag.js)

## Directory Structure

```
/
├── package.json            # Root npm scripts (tests, sam:build); no Lambda deps
├── index.html              # Main entry point
├── admin/                  # Private contact admin (static HTML + ../js/admin.js)
├── css/
├── js/
├── aws/
│   ├── template.yaml         # SAM: contact HttpApi, DynamoDB, SQS, Lambdas
│   ├── chat-template.yaml    # SAM: chat HttpApi + Lambda container (FastAPI + Gemini)
│   ├── samconfig.toml      # Stack name / region defaults (no secrets)
│   └── src/
│       ├── package.json    # @aws-sdk deps — bundled by `sam build` into each function
│       ├── contact-ingress.js, contact-sender.js, contact-report.js, contact-admin.js
│       ├── backfill-listpk.js  # One-off: add listPk for GSI (see README)
│       └── common/
├── scripts/
│   ├── integrate-and-deploy.sh   # Secrets Manager prep (when manifests exist) + sam build/deploy + chat + HTML meta [prod|stage]
│   ├── sync-site-api-urls.mjs
│   ├── seed_local_configs.py, push_local_secrets_to_sm.py
├── secrets.example/        # Templates for .secrets/ (deploy.env, manifests)
├── test/                   # node:test (e.g. starfield-reduced-motion)
├── data/
├── resume/
├── fib/
└── *.png, *.jpg, *.jpeg
```

## Development

### Running Locally

No bundler for the static site. Serve with any static HTTP server:

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .

# PHP
php -S localhost:8000
```

Then open `http://localhost:8000` in a browser.

**Note**: ES6 modules require HTTP serving — opening `index.html` directly via `file://` will not work due to CORS restrictions on module imports.

### npm (root)

- **`package.json`** at repo root: `npm run test:reduced-motion` (node:test), `npm run sam:build` (contact SAM), `npm run sam:build:chat` (chat Lambda image SAM build), `npm run chat:discover-env` (prints `CHAT_ECS_*` + ECR URI for `chat-deploy.env`).
- **Lambda dependencies** live only in **`aws/src/package.json`** (`@aws-sdk/*`). `sam build` runs `npm install` there and ships `node_modules` with each function.

### SAM / deploy

- **Canonical env names**: [`secrets.example/deploy.env.example`](secrets.example/deploy.env.example) → copy to `.secrets/deploy.env`.
- **Deploy**: `bash scripts/integrate-and-deploy.sh [prod|stage]` — default `prod`; `stage` uses `SAM_STACK_NAME_STAGE` (default `page-staging`). When `.secrets/manifest.json` + `config.manifest.json` exist, runs Secrets Manager seed/push first (skip with `SKIP_SECRETS_MANAGER=1`). Loads `.secrets/deploy.env` when `RESEND_API_KEY` is unset; optional `.secrets/chat-deploy.env` for chat ECR/ECS. Voice is **always on** in the FE (no meta flag); the deploy script auto-bootstraps ECS chat prereqs by default (**`CHAT_VOICE_ECS_BOOTSTRAP=1`**) — creates ECR repo `gvp-chat`, defaults `CHAT_ECS_SAM_STACK_NAME_{stage,prod}=gvp-chat-ecs-{stage,prod}`, and resolves VPC/subnets via EC2 describe; with **`CHAT_ECS_CREATE_DEFAULT_VPC=1`** (default during the bootstrap) the same run can call **`aws ec2 create-default-vpc`** if nothing qualifies (IAM **`ec2:CreateDefaultVpc`**). Opt out with **`CHAT_ECS_CREATE_DEFAULT_VPC=0`** (manual IDs only) or **`CHAT_VOICE_ECS_BOOTSTRAP=0`** (Lambda-only chat; voice will fail at the network level, text chat still works).
- **CI**: GitHub Actions workflow **Integrate and deploy** — same secret names as `deploy.env.example`; workflow input **deploy_environment** (`prod` / `stage`).

### Tests

- **`npm run test:reduced-motion`** — `node:test` against `js/starfield-prefs.js`.
- No browser E2E suite; verify UI manually after static or Lambda changes.

### CI/CD

- Optional **GitHub Actions** workflow for SAM deploy (see `README.md`). Static hosting (e.g. Amplify) is separate from the AWS contact stack.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for Mermaid diagrams (Amplify static site, contact SAM, chat Lambda/ECS, deploy).

### Module System

`app.js` is the orchestrator. It imports all modules and initializes them in order on `DOMContentLoaded`:

1. `initAnalytics()` — sets up Google Analytics (gtag; `send_page_view: false` so navigation emits virtual `page_view`)
2. `bindOutboundTracking()` — wires `[data-track]` elements for outbound events
3. `initTheme()` — reads saved theme from localStorage, applies it
4. `initStarfield()` — starts canvas background animation
5. `initContactForm()` — contact form wiring
6. `initSpaceman()` — loads character data, renders DOM, starts message cycle
7. `initSpacemanPosition()` — viewport-aware positioning with observers
8. `initNavigation()` — hash-based routing with state callbacks
9. `loadProjects()` / `renderProjects()` — fetches JSON, builds project cards
10. `IntersectionObserver` — tracks which project card is in view for spaceman context

### Theme System (`theme.js`)

Two themes: `space` and `garden`. Stored in `localStorage` under key `gvp-theme`.

- Theme is applied via `data-theme` attribute on `<html>`
- CSS variables in `:root` / `[data-theme="space"]` and `[data-theme="garden"]` drive all colors
- Theme changes dispatch a `themechange` CustomEvent on `window`
- Transition uses a full-screen overlay fade (respects `prefers-reduced-motion`)

### Navigation (`navigation.js`)

Hash-based routing (`#home`, `#playground`, `#portfolio`). Uses `history.replaceState` + `hashchange` listener. Sections toggle via CSS classes (`hidden`/`visible`/`section-invisible`).

### Spaceman Character (`spaceman.js` + `spaceman-position.js`)

The `Spaceman` class manages:
- **State machine**: `idle`, `home`, `playground`, `portfolio`
- **Message cycling**: typed letter-by-letter from theme-aware data + resume enrichment
- **Reactions**: hover, click (double-click triggers boost), long idle
- **Quiet mode**: single-click opens menu, hides messages, moves to corner
- **Idle animations**: blink, wave on random intervals

`SpacemanPosition` handles responsive positioning using `MutationObserver`, `ResizeObserver`, and `IntersectionObserver`.

### Canvas Background (`starfield.js`)

- **Space theme**: 3D starfield with perspective projection, motion streaks, color gradients
- **Garden theme**: falling snowflakes over the DOM garden scene (sky, trees, ocean)
- Star count scales with viewport area and `navigator.hardwareConcurrency`
- Reinitializes on theme change and window resize

### Data Files

- `data/projects.json` — project cards with `id`, `title`, `description`, `image`, `link`, `hidden` flag
- `data/spaceman.json` — messages per state, reactions, theme-specific variants under `themeMessages`
- `resume/resume.json` — structured resume data; spaceman.js merges this into messages dynamically

### Contact backend (`aws/`)

- **Ingress** validates JSON, writes DynamoDB (items include `listPk: CONTACT` for the admin list GSI), enqueues SQS.
- **Sender** drains SQS, sends email via Resend (`fetch` in `common/resend.js`, no Resend npm package).
- **Admin** `GET /messages` queries GSI `byCreatedAt` with `?limit` and optional `?cursor` (opaque); response includes `nextCursor`. **Summary** aggregates status counts via a paginated `Scan` with projected attributes.
- **Failure report** uses a paginated `Scan` with a filter for failed, non-suppressed rows.

## Code Conventions

### JavaScript

- ES6 module syntax (`import`/`export`) — no CommonJS
- Classes for stateful components (`Spaceman`, `SpacemanPosition`)
- Exported `init*` factory functions as public API
- Private methods prefixed with `_` (e.g., `_startMessageCycle`, `_bindEvents`)
- Timer management via `_timers` object with `_clearTimer` / `_clearAllTimers` helpers
- No semicolons at end of lines
- Single quotes for strings (except in template literals and HTML attributes)
- 2-space indentation

### CSS

- CSS custom properties (`--var-name`) for all theme-dependent values
- Theme scoped via `[data-theme="..."]` attribute selectors
- Mobile-first responsive breakpoints at `767px` and `1024px`
- Animations via `@keyframes` and CSS transitions
- BEM-like class naming for spaceman components (`.spaceman-body`, `.spaceman-quiet-menu`)
- `z-index` layering: canvas (-1), garden scene (-2), content (100-101), nav (1000), footer (999)

### HTML

- Semantic elements (`<header>`, `<main>`, `<footer>`, `<nav>`, `<section>`)
- `aria-hidden="true"` on decorative elements
- IDs for JavaScript hooks, classes for styling
- Dynamic content rendered via JS DOM creation (not innerHTML for user data)

### Git Commits

Short, lowercase messages. Common prefixes: `fix:`, `fixes:`. No conventional commit enforcement.
