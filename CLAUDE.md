# CLAUDE.md

## Project Overview

Personal portfolio website for Marwan Elgendy ("The Computerist"). A static site with dual themes (Space and Garden), an animated interactive "Spaceman" character, and sections for Playground (experimental projects) and Portfolio (professional experience).

**Live site**: Static HTML/CSS/JS — no build step, no bundler, no framework.

## Tech Stack

- **HTML5** — single `index.html` entry point
- **CSS3** — CSS custom properties for theming, keyframe animations, responsive design
- **Vanilla JavaScript (ES6 modules)** — `<script type="module">` loading from `js/app.js`
- **Canvas API** — starfield (space theme) and rain (garden theme) animations
- **External CDN only**: Google Fonts (Roboto, Open Sans), Google Analytics/Tag Manager

## Directory Structure

```
/
├── index.html              # Main entry point
├── css/
│   ├── styles.css          # Layout, theme variables, responsive styles
│   └── spaceman.css        # Spaceman character animations & styling
├── js/
│   ├── app.js              # Entry point — initializes all modules
│   ├── analytics.js        # Google Analytics gtag wrapper
│   ├── navigation.js       # Hash-based navigation state management
│   ├── theme.js            # Theme system (space/garden) with transitions
│   ├── projects.js         # Fetches and renders project cards from JSON
│   ├── spaceman.js         # Spaceman character controller (messages, reactions, animations)
│   ├── spaceman-position.js # Viewport-aware positioning for the spaceman
│   └── starfield.js        # Canvas background — starfield (space) or rain (garden)
├── data/
│   ├── projects.json       # Project definitions (playground + portfolio)
│   ├── spaceman.json       # Character messages, reactions, theme variants
│   └── agent-messages-*.   # Reference data for spaceman messages
├── resume/
│   ├── resume.json         # Structured resume data consumed by spaceman.js
│   └── *.pdf               # PDF resume files
├── fib/
│   └── index.html          # Standalone Fibonacci visualization demo
└── *.png, *.jpg, *.jpeg    # Project images (root level)
```

## Development

### Running Locally

No build step required. Serve with any static HTTP server:

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

### No Build System

There is no package.json, no npm dependencies, no bundler, no transpiler. All code runs directly in the browser as-is.

### No Tests

There is no test framework or test suite. Changes should be verified manually in the browser.

### No CI/CD

There is no CI/CD pipeline. Deployment is static file hosting.

## Architecture

### Module System

`app.js` is the orchestrator. It imports all modules and initializes them in order on `DOMContentLoaded`:

1. `initAnalytics()` — sets up Google Analytics
2. `initTheme()` — reads saved theme from localStorage, applies it
3. `initStarfield()` — starts canvas background animation
4. `initSpaceman()` — loads character data, renders DOM, starts message cycle
5. `initSpacemanPosition()` — viewport-aware positioning with observers
6. `initNavigation()` — hash-based routing with state callbacks
7. `loadProjects()` / `renderProjects()` — fetches JSON, builds project cards
8. `IntersectionObserver` — tracks which project card is in view for spaceman context

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
- **Garden theme**: falling rain drops
- Star count scales with viewport area and `navigator.hardwareConcurrency`
- Reinitializes on theme change and window resize

### Data Files

- `data/projects.json` — project cards with `id`, `title`, `description`, `image`, `link`, `hidden` flag
- `data/spaceman.json` — messages per state, reactions, theme-specific variants under `themeMessages`
- `resume/resume.json` — structured resume data; spaceman.js merges this into messages dynamically

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
