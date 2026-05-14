# Coordinator — Frontend & Static site

**Mission:** Ship the static site so **contact** and **chat** resolve correctly in production (meta, CDN rewrites, optional cross-origin), matching [TEAM_UI.md](../parallel-phases/TEAM_UI.md).

## Coordinator responsibilities

- Own [`index.html`](../../index.html), [`js/chatbot.js`](../../js/chatbot.js), [`js/contact.js`](../../js/contact.js), [`js/app.js`](../../js/app.js), [`css/styles.css`](../../css/styles.css), [`scripts/sync-site-api-urls.mjs`](../../scripts/sync-site-api-urls.mjs), [`scripts/integrate-and-deploy.sh`](../../scripts/integrate-and-deploy.sh) (only where it touches HTML meta).
- **Chat URL:** ensure production `gvp:chat-api-url` is set OR origin proxies `/api/chat`—never ship a state where meta is empty and CDN has no `/api/chat` route unless intentional.
- **Sync automation:** extend `sync-site-api-urls.mjs` (or add `sync-chat-api-url.mjs`) to patch `gvp:chat-api-url` in `index.html` + `admin/index.html` if needed.
- **Contact fetch:** add `Content-Type: application/json` in [`js/contact.js`](../../js/contact.js) for parity with chat and strict gateways.
- **Privacy / UX:** optional short notice near chat that messages leave the browser and may be processed by an LLM (product/legal, not only engineering).

## Pre-audit notes (squad input)

- Cross-origin chat requires CORS on chat service or same-origin proxy; chat FastAPI has no CORS today.
- Localhost detection is hostname-limited; LAN dev may need explicit meta content.

## Production definition of done

- [ ] Production HTML has correct `gvp:contact-api-url` and `gvp:chat-api-url` (or documented proxy-only strategy).
- [ ] CI or deploy script updates both metas when URLs change.
- [ ] Manual pass: both themes, keyboard, `aria-live`, contact + chat on prod-like URL.
- [ ] Contact POST sends JSON `Content-Type`.

---

### Worker agent prompt (copy below)

```
You are a worker for Frontend/Static under /Users/marwanelgendy/workspace/PP/gvp.
Read docs/production-readiness/COORDINATOR-FRONTEND-STATIC.md and docs/parallel-phases/TEAM_UI.md.
Implement one slice: (A) extend scripts/sync-site-api-urls.mjs for optional chat meta second arg, (B) add Content-Type to contact fetch, (C) short privacy/helper line near chat panel in index.html + styles only if needed.
Preserve spaceman, navigation, CLAUDE.md JS conventions. Minimal diff.
```
