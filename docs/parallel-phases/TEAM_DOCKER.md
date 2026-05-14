# Team Docker — Phase 1 brief (parallel)

**Mission:** Ship a reproducible local stack with `docker compose up` (or equivalent) so the static site, mock contact API, and chat API are reachable on **one origin** (same host/port). Everything must be **verified running** before handoff.

**You own:** Compose topology, reverse proxy, container images, health checks, smoke/verification commands, minimal CI hooks (optional) that prove `compose config` + image build.

**You do not own:** LangChain logic (Team Chatbot), hero layout and styles (Team UI). You **do** define stable URLs and env contracts they consume.

---

## Deliverables

1. **`docker-compose.yml`** (repo root or `docker/`) with services at minimum:
   - **proxy** — public port (e.g. `8080:80`); only entry from host browser.
   - **static** or proxy-only with volume — site root mounted read-only from repo (`.`) so `index.html`, `js/`, `css/`, `data/` load without rebuild on file change.
   - **mock-contact** — implements `POST /api/contact` compatible with [`js/contact.js`](../../js/contact.js) (JSON body, JSON response, honeypot behavior aligned with [`aws/src/contact-ingress.js`](../../aws/src/contact-ingress.js)).
   - **chat** — upstream for chat (Team Chatbot supplies the image/Dockerfile; you wire `depends_on` + healthcheck).

2. **Reverse proxy config** (nginx or Caddy) — single file, versioned in repo:
   - `/` → static files.
   - `/api/contact` → mock-contact (preserve path or strip prefix consistently; **must** match what the browser sends).
   - `/api/chat` → chat service (prefix agreed with Team Chatbot; default `POST /api/chat` on upstream).

3. **Documentation snippet** for [`README.md`](../../README.md): exact commands, URL to open, how to stop, how to rebuild one service.

---

## Contracts (do not break)

| Path | Method | Notes |
|------|--------|--------|
| `/api/contact` | POST | Body: `{ name, email, subject, message, company }`. Honeypot: non-empty `company` → `200` success without persistence semantics matching production “silent accept”. |
| `/api/chat` | POST (SSE optional later) | Proxied to chat container; CORS usually unnecessary if same origin. |

**Environment:** Document required/optional env vars for compose; secrets only via `.env` (gitignored) or compose `env_file` — never commit keys.

---

## Testing and “running” acceptance (mandatory)

Complete **all** before marking phase done:

1. **Config validation:** `docker compose config` exits 0 (no YAML errors, no missing env for required services).
2. **Build:** `docker compose build` completes for every service with a Dockerfile.
3. **Up:** `docker compose up -d` then wait for healthchecks green (or documented sleep + curl loop).
4. **Smoke — static:** `curl -fsS -o /dev/null -w "%{http_code}" http://localhost:8080/` → `200`.
5. **Smoke — mock contact:**  
   `curl -fsS http://localhost:8080/api/contact -X POST -H 'Content-Type: application/json' -d '{"email":"a@b.co","message":"hi"}'` → HTTP 200 and JSON body that [`js/contact.js`](../../js/contact.js) treats as success (`ok` / message flow).
6. **Smoke — chat:** HTTP 200 (or documented 4xx for missing key **only** when mock mode off) on minimal valid chat payload — exact JSON agreed with Team Chatbot (placeholder: `{"messages":[{"role":"user","content":"ping"}]}`).
7. **Browser:** Open `http://localhost:8080`, confirm home loads, theme toggle works, **Contact** still opens and submit hits mock (Network tab shows same-origin `/api/contact`).
8. **Teardown:** `docker compose down` leaves no orphaned containers (document if named volumes need `down -v`).

Optional but valuable: a **`scripts/docker-smoke.sh`** (or `make smoke-docker`) that runs steps 4–6 with `set -euo pipefail` so CI or humans get one command.

---

## Handoff to other teams

- **Team Chatbot:** Provide service name, internal port, env file template, and healthcheck endpoint path (e.g. `GET /health` → `200`).
- **Team UI:** They assume origin `http://localhost:8080` and paths `/api/chat`, `/api/contact` for local dev (meta `window.__CHAT_API_URL__` / contact URL patterns already used for localhost).

---

## Risks

- **Path stripping:** nginx `proxy_pass` trailing slash changes URI — test with real `fetch` from the browser, not only `curl` to upstream.
- **ARM vs x86:** Prefer multi-stage builds and widely available base images; document Apple Silicon quirks if any.

---

## Definition of done

- [ ] `docker compose up` from clean clone (after documented prereqs) serves the site and both APIs on one port.
- [ ] Smoke script or numbered commands in README all pass locally.
- [ ] No secrets in git; example env in `secrets.example/` or `docker/.env.example` only.
