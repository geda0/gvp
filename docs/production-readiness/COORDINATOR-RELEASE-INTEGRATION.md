# Coordinator — Release & Integration

**Mission:** Sequence work across squads so **static site (Amplify or similar)**, **AWS contact SAM stack**, and **chat host** (container service, Fly, ECS, etc.) go live without contract drift.

## Original plan trace

- Local all-in-one: [TEAM_DOCKER.md](../parallel-phases/TEAM_DOCKER.md).
- Chat not in SAM today—treat chat as **separate deployable** unless/until template adds it.

## Coordinator responsibilities

- Maintain a **release checklist** (below) and assign Platform / Backend / Frontend coordinators in order.
- Resolve **single contract**: `POST /api/chat` body and response; nginx or CDN path `/api/chat`; meta `gvp:chat-api-url` vs relative `/api/chat`.
- Ensure **secrets** live only in host env / Secrets Manager—never in built static assets.
- After each squad finishes, run **smoke**: static loads, contact works against real ingress, chat works against real chat URL (or proxied path).

## Cross-squad checklist (order)

1. **Backend:** Image builds; `/health` or `/ready` matches orchestrator; env vars documented for prod provider.
2. **Platform:** If using compose on a VM—TLS, firewall, pins; if **not** using compose in prod—document that dev compose is dev-only.
3. **Frontend:** Metas + rewrites; `sync-*` scripts run in CI/deploy; admin `index.html` updated if contact URL changes.
4. **AWS contact (existing):** [`scripts/integrate-and-deploy.sh`](../../scripts/integrate-and-deploy.sh) unchanged for SAM; confirm contact meta still points at API Gateway URL.
5. **Chat host:** Deploy container (or serverless adapter); attach HTTPS URL to meta or to CDN origin rule.

## Sign-off matrix

| Gate | Owner | Evidence |
|------|--------|----------|
| Static build / upload | Frontend coord | Prod URL loads, no console errors on home |
| Contact E2E | Release | Form 200, email received or queue OK |
| Chat E2E | Release | Question returns grounded reply; 503 never on happy path when provider configured |
| Security pass | Release | No keys in repo; CORS/origin documented |
| Rollback | Release | Prior static artifact + prior image tag recorded |

---

### Worker agent prompt (copy below)

```
You are the release integration worker for /Users/marwanelgendy/workspace/PP/gvp.
Read docs/production-readiness/COORDINATOR-RELEASE-INTEGRATION.md and README.md deploy sections.
Produce a single markdown file docs/production-readiness/RUNBOOK-prod.md (or update if exists) with: deploy order, URLs to set, smoke commands, rollback—no unrelated refactors.
If RUNBOOK exists, append a dated "Release notes" section only.
```
