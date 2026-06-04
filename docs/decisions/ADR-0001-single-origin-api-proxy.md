# ADR-0001 — Single-origin `/api/*` proxy with meta-tag base URLs

## Status

Accepted. (Retroactively recorded during the teamentic adoption bootstrap; the
decision was already implemented and is in production.)

## Context

The frontend is a no-bundler static site (ES modules from `js/app.js`) served from
AWS Amplify, while the backends live on separate AWS origins (contact HTTP API on
`execute-api`, chat on an ALB host). The browser needs to reach two backends —
contact and chat (plus voice) — without hardcoding cross-origin hosts into shipped
JS, and local dev needs to behave like prod (same paths, same CORS shape).

## Decision

The browser always calls relative `/api/*` paths conceptually, and the absolute base
URL is injected at the edge via HTML `<meta>` tags resolved once at boot:

- `js/site-config.js:5-15` reads `gvp:contact-api-url` → `contactApiUrl` and
  `gvp:chat-api-url` → `chatApiUrl`. When the meta is empty **and** the host is
  `localhost`/`127.0.0.1`, it falls back to `/api/contact` / `/api/chat`
  (`site-config.js:11,14-15`). It also mirrors both onto `window.__CONTACT_API_URL__`
  / `window.__CHAT_API_URL__` for the admin SPA (`site-config.js:17-20`).
- Production meta values are patched **post-deploy** by `scripts/sync-site-api-urls.mjs`,
  which rewrites `<meta name="gvp:contact-api-url">` and (optionally)
  `gvp:chat-api-url` in `index.html` and `admin/index.html`
  (`sync-site-api-urls.mjs:49-63`). Current shipped values: contact →
  `…execute-api…/api/contact` (`index.html:38`), chat →
  `https://chat-api.marwanelgendy.link/api/chat` (`index.html:39`).
- Local dev mirrors prod through nginx on `:8080`: `/` serves the repo root,
  `/api/contact` → `mock-contact:8001`, `/api/chat` and `/api/live/*` → `chat:8000`
  (`docker/nginx.conf:19,28,45`; `docker-compose.yml:40-51`).

## Consequences

- Never hardcode a cross-origin API host in frontend JS. The `<meta>` tag + `/api/*`
  proxy is the load-bearing contract; changing how URLs resolve means touching
  `site-config.js` and `sync-site-api-urls.mjs` together.
- The local fallback is gated on hostname, so a deployed page with empty meta returns
  `''` (not `/api/...`) — meta patching after deploy is mandatory, not optional.
- `admin/index.html` ships **only** `gvp:contact-api-url` (`admin/index.html:14`), no
  `gvp:chat-api-url`; the sync script treats the chat meta as `required:false` there
  (`sync-site-api-urls.mjs:59-61`), and admin chat-transcript routes ride the contact
  origin. This matches the code; the architecture doc's "admin/index.html if that meta
  exists" wording (README:50) is consistent with this.
