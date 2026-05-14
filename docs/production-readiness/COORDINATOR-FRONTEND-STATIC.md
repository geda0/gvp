# Coordinator — Frontend & Static site

**Mission:** Ship the static site so **contact** and **chat** resolve correctly in production (meta, CDN rewrites, optional cross-origin), matching [TEAM_UI.md](../parallel-phases/TEAM_UI.md).

## Coordinator responsibilities

- Own [`index.html`](../../index.html), [`js/chat.js`](../../js/chat.js), [`js/contact.js`](../../js/contact.js), [`js/app.js`](../../js/app.js), [`css/styles.css`](../../css/styles.css), [`css/chat.css`](../../css/chat.css), [`scripts/sync-site-api-urls.mjs`](../../scripts/sync-site-api-urls.mjs), [`scripts/integrate-and-deploy.sh`](../../scripts/integrate-and-deploy.sh) (only where it touches HTML meta).
- **Chat URL:** ensure production `gvp:chat-api-url` is set OR origin proxies `/api/chat`—never ship a state where meta is empty and CDN has no `/api/chat` route unless intentional.
- **Sync automation:** `sync-site-api-urls.mjs` patches `gvp:contact-api-url` and optional `gvp:chat-api-url` in `index.html` (and `admin/index.html` where present).
- **Contact fetch:** [`js/contact.js`](../../js/contact.js) sends **`Content-Type: application/json`** on `POST` (required for API Gateway + strict proxies).
- **Chat CORS:** enforced in FastAPI via **`CHAT_CORS_ORIGINS`** (see [`docker/chat/app/main.py`](../../docker/chat/app/main.py)); the chat SAM template does **not** set HttpApi `CorsConfiguration`—origins must be configured for the Lambda environment.
- **Privacy / UX:** optional short notice near chat that messages leave the browser and may be processed by an LLM (product/legal, not only engineering).

## Pre-audit notes (squad input)

- Cross-origin chat requires **`CHAT_CORS_ORIGINS`** to include the real browser origin(s), or a same-origin `/api/chat` proxy.
- Localhost detection is hostname-limited; LAN dev may need explicit meta content.

## Production definition of done

- [ ] Production HTML has correct `gvp:contact-api-url` and `gvp:chat-api-url` (or documented proxy-only strategy).
- [ ] CI or deploy script updates both metas when URLs change (note: GitHub **Integrate and deploy** workflow **sync_api_urls** defaults to **off**; local `integrate-and-deploy.sh` treats **`SYNC_API_URLS`** as on unless set to `0`).
- [ ] Manual pass: both themes, keyboard, `aria-live`, contact + chat on prod-like URL.
- [ ] Contact POST sends JSON `Content-Type`.

---

### Worker agent prompt (copy below)

```
You are a worker for Frontend/Static under /Users/marwanelgendy/workspace/PP/gvp.
Read docs/production-readiness/COORDINATOR-FRONTEND-STATIC.md and docs/parallel-phases/TEAM_UI.md.
Implement one slice aligned with current code (contact JSON + chat CORS env + meta sync). Preserve spaceman, navigation, CLAUDE.md JS conventions. Minimal diff.
```
