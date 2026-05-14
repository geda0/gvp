# Coordinator — Platform & Infra

**Mission:** Make the **Docker + nginx + mock** path safe, reproducible, and ready to sit behind a real edge (or stay dev-only with explicit boundaries).

**Original plan:** [TEAM_DOCKER.md](../parallel-phases/TEAM_DOCKER.md) — single origin, healthchecks, smoke, no secrets in git.

## Coordinator responsibilities

- Own [`docker-compose.yml`](../../docker-compose.yml), [`docker/nginx.conf`](../../docker/nginx.conf), [`docker/mock-contact/`](../../docker/mock-contact/), [`scripts/docker-smoke.sh`](../../scripts/docker-smoke.sh).
- Decide **image pin policy** (digest or minor-pinned tags) for `nginx` and Python bases.
- Add or approve **CI** job: `docker compose config` + `docker compose build` (optional `up` + smoke on runner with Docker).
- Document **TLS**: local stack is HTTP-only; production terminates TLS at LB/CDN or adds nginx `443` config—do not imply this compose is internet-complete without that layer.
- Align **mock-contact** honeypot / success JSON with TEAM_DOCKER if tests or analytics depend on `persisted` semantics.

## Pre-audit notes (squad input)

- Floating `nginx:alpine`; consider `nginx:1.xx-alpine` or digest pin.
- No `proxy` service healthcheck; optional `location = /nginx-health` + compose check.
- `docker/.env.example` is committed; use with root `.env` (gitignored) for non-mock keys—see [docker/.env.example](../../docker/.env.example).

## Production definition of done

- [ ] `docker compose config` and `docker compose build` pass in CI on default branch.
- [ ] README “Local Docker” matches actual ports and services (chat on **8000** internally; host **8080** → proxy **80**).
- [ ] Documented path for **production** static + API (separate from bind-mount dev stack): e.g. immutable image, Amplify rewrites, or managed gateway.
- [ ] Mock-contact CORS restricted if service is ever reachable beyond localhost.

---

### Worker agent prompt (copy below)

```
You are a worker for Platform/Infra under /Users/marwanelgendy/workspace/PP/gvp.
Read docs/production-readiness/COORDINATOR-PLATFORM-INFRA.md and docs/parallel-phases/TEAM_DOCKER.md.
Implement only what the coordinator scoped: e.g. pin nginx image, add proxy healthcheck + nginx location, add GitHub Actions job for compose config+build, or tighten mock-contact CORS for non-* origins when env says production.
Do not change chat business logic or FE without coordinator sign-off. Short commit message, minimal diff.
```
