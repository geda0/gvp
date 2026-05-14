# Team UI — Phase 3 brief (parallel)

**Mission:** Make the **chatbot the visual and interaction centerpiece** of the home experience: **usable**, **presentable**, and **creative** within the existing Space / Garden identity (typography, CSS variables, spaceman world).

**You own:** [`index.html`](../../index.html) structure for the hero, new [`js/chatbot.js`](../../js/chatbot.js) (or split modules), CSS in [`css/styles.css`](../../css/styles.css) (and small additions to [`css/spaceman.css`](../../css/spaceman.css) only if required for collision), accessibility, responsive behavior, empty/loading/error states.

**You do not own:** Reverse proxy, model keys, LangChain. You **consume** the HTTP contract documented by Team Chatbot and base URLs from meta / `window` globals (mirror the contact pattern).

---

## Creative direction (within brand)

- **Metaphor:** “Ground control” / calm mission panel — not a generic Intercom bubble. Use existing **radii**, **shadows**, and **surface-elevated** tokens so Space and Garden both feel native.
- **Distinctive touches (pick 1–2, do not clutter):**
  - Subtle **gradient border** or inner glow on the chat card that shifts with `data-theme`.
  - **Monospace accent** only for timestamps or “status” line, not entire transcript (readability).
  - **Soft entrance** animation on first paint; **respect `prefers-reduced-motion`** (no parallax, no mandatory motion to read content).
- **Spaceman coexistence:** Chat is **first in DOM order** on mobile (primary task); spaceman remains fixed — avoid overlapping critical controls (composer send button, input). If overlap occurs at common breakpoints, reduce chat max-height or add bottom padding to `#contentWrapper` / hero so the spaceman does not obscure the composer.

---

## Usability requirements

1. **Keyboard:** Enter sends (Shift+Enter newline in textarea); focus visible on all controls; logical tab order: transcript region (read-only live region) → input → send → secondary actions.
2. **Screen readers:** Transcript updates in a single **`aria-live="polite"`** region; label the composer (`aria-label`); announce errors in live region or `role="alert"` for failures.
3. **Touch:** Minimum **44×44px** hit target for send; avoid hover-only affordances.
4. **States:** Idle, loading (in-progress send), error (retry + message), empty transcript placeholder copy that invites one example question.
5. **Performance:** No layout thrash on each streamed token if streaming is added later — batch DOM updates (`requestAnimationFrame` or buffer text).

---

## Layout (presentable)

- **Desktop (≥1024px):** Two-column hero: **chat column wider** (≈ 55–60%) + **copy column** (headline, subtitle, CTAs, highlights). Chat card max-height with internal scroll for transcript; composer **pinned to bottom** of card.
- **Tablet:** Stack or narrower columns; chat still visually dominant.
- **Mobile:** Chat **above** headline block; full width with comfortable horizontal padding matching `section#home`.

**Polish:** Consistent spacing scale (8/12/16/24), no clipped focus rings, scrollbars themed subtly to match surfaces.

---

## API integration (contract with Team Chatbot)

- Read **`window.__CHAT_API_URL__`** (set like contact from `meta[name="gvp:chat-api-url"]` with localhost default `/api/chat`).
- **`POST`** JSON per Team Chatbot spec; handle non-JSON error bodies gracefully.
- Map server errors to human copy (“Service busy, try again”) without leaking stack traces.

**Do not** store API keys in the frontend.

---

## Visual QA checklist (both themes)

- [ ] Space: readable contrast on transcript bubbles / borders (`--text-primary` on `--surface-elevated`).
- [ ] Garden: same; no “washed out” placeholder text.
- [ ] Theme toggle with chat open: no flash of unstyled content; borders update.
- [ ] Long assistant reply scrolls inside panel, not entire page.
- [ ] `prefers-reduced-motion: reduce` — no scale/bounce animations.

---

## Handoff

- **Team Docker:** Confirm final path `/api/chat` and CORS (ideally none, same origin).
- **Team Chatbot:** Finalize error JSON shape for consistent UI mapping.

---

## Definition of done

- [ ] Home hero clearly leads with chat; site still feels like the same portfolio (not a different product).
- [ ] Lighthouse-style sanity: no critical a11y regressions on home (manual axe or Lighthouse optional).
- [ ] Works at `http://localhost:8080` behind Team Docker stack with mock chat responses.
- [ ] Contact flow and navigation (`#playground`, `#portfolio`) unchanged in behavior.
