# Releases

_Owned by the project-manager. One row per release — recorded only after health is
verified. Never release on a red bar or unaccepted work._

| Milestone | Commit | Tag | Environment | Health | Date |
|-----------|--------|-----|-------------|--------|------|
| **PRODUCTION** Team Tactics contact CTA (private repo → contact form) | `d9ce997` (main) · deploy run `27051407724` | — | **prod** | **GREEN** (test ✅ + deploy ✅). Merge agent→main preserving prod API metas (`lwi0vmdpb5…` contact, `gv-0277…` chat Express). Labs **Request access** opens prefilled contact dialog; no public GitHub link. Staging qa-verifier PASS before promote. Amplify rebuild of `main` → `www.marwanelgendy.link`. Contact SAM `page` UPDATE_COMPLETE; prod chat ECS untouched. | 2026-06-06 | | `b099019` (agent) · deploy run `26929994505` | — | **staging** | **GREEN end-to-end.** New `deploy-staging.yml` (push→agent, path-filtered, test-gated) ran `integrate-and-deploy.sh stage` via OIDC role `gvp-staging-ci-deploy`. Deployed **contact `page-staging`** (`fvfqpef8kb…` — matches the frontend's contact meta ✓) + **chat Lambda `gvp-chat-stage`** (`m7qmz78kb6…`). Health: chat /health+/ready 200, contact OPTIONS 204. Frontend (Amplify) serves `chat.marwanelgendy.link`. | 2026-06-04 |
| Chat topology resolved → CI is contact-only | — | — | staging | Navigator chose **contact-only CI; chat stays manual (ECS)**. Removed the `CHAT_SAM_STACK_NAME` repo var (CI deploys only `page-staging`) and **tightened** the `gvp-staging-ci-deploy` IAM policy to contact-only (dropped ECR + chat scopes). **Tore down the orphaned** `gvp-chat-stage` + `*-CompanionStack` + its companion ECR repo. PRESERVED: `gvp-chat` (ECS voice repo), `page-staging`, the SAM bucket. Frontend chat keeps using the ECS `chat-api-stage…`. | 2026-06-04 |
| Staging deploy (contact-only) + team-tactics 0.8.5 | `8f4584c` (agent) · deploy run `26936642631` | — | **staging** | **GREEN** (test ✅ + deploy ✅, 55s). First contact-only run via the tightened `gvp-staging-ci-deploy` role. `page-staging` ContactApiUrl `fvfqpef8kb…` OPTIONS 204 (matches FE meta); frontend `chat.marwanelgendy.link` 200; ECS chat `chat-api-stage` 200 (untouched). 0.8.5 merged onto agent. ⚠ CI uses Node20 actions (GitHub deprecation 2026-06-16). | 2026-06-04 |
| **PRODUCTION deploy** (contact refactor → prod) | `fda626f` (main) · deploy run `26938125929` | — | **prod** | **GREEN** (test ✅ + deploy ✅, 1m23s). New `deploy-prod.yml` (push→main, test-gated) ran `integrate-and-deploy.sh prod` via OIDC role `gvp-prod-ci-deploy` (main-only, page-scoped). QA-gated by a staging E2E contact submission (qa-verifier PASS). `page` UPDATE_COMPLETE; contact `lwi0vmdpb5…` OPTIONS 204 (matches FE prod meta); `www.marwanelgendy.link` 200; prod chat ECS `chat-api.marwanelgendy.link` 200 (untouched). Frontend unchanged (Amplify rebuild of `main`). | 2026-06-04 |

## 2026-06-17 — Pre-prod hardening → STAGING (GREEN)
- Branch `agent` @ `d242979` (commits 27ef7f6 ttics/gate, 1d0354d hardening, d242979 ci+deploy fixes).
- deploy-staging run 27720539158 GREEN: test 120/120/0, deploy OK. `page-staging` + `gvp-chat-express-stage` UPDATE_COMPLETE; IpHashPepper + SmokeProbeKey provisioned (chat task def rev 18).
- qa-verifier PASS (5/5): live keyed ipHash (HMAC pepper active), honest events received/persisted/dropped, /api/chat/smoke trust-domain split (401 no-key + 401 admin-key), consent gate served, staging metas correct. Test data cleaned; zero defects.
- Prod untouched. New prereq secrets (IP_HASH_PEPPER, SMOKE_PROBE_KEY) mapped in deploy-staging.yml + deploy-prod.yml.
- Deferred: S16 AWS Budget alarm (owner runbook), S30 per-IP WAF (ADR-0009 rejected for this blast radius).

## 2026-06-17 — PROMOTED TO PROD (GREEN + qa PASS)
- `main` @ `d45e18d` (FF from agent ff93fff + prod-host re-pin). deploy-prod run 27722767780 GREEN (test+env-guard=prod + deploy).
- `page` UPDATE_COMPLETE — NEW prod resources created clean: SiteEventsTable, EventsIngressFunction, DailyReportFunction, DailyDigest cron (12:00 UTC, ENABLED), DailyReport+ContactFailureReport Errors alarms; IpHashPepper+SmokeProbeKey params. `gvp-chat-express-prod` UPDATE_COMPLETE (image prod-d45e18d, SmokeProbeKey).
- Required a prod-IAM widening (owner-authorized): gvp-prod-deploy policy IAM resource page-Contact* -> page-* (to create the new non-Contact Lambda roles).
- qa PASS on prod: keyed ipHash 5ac3d2dd… (IP_HASH_PEPPER live, not inert), smoke trust-split 401/401, consent served, prod metas (no staging leak). Live www serves PROD hosts.
- Amplify prod app = d2ey3rf8zwq2lv ("home", main->www/apex), build job 242 SUCCEEDED.
- Open (owner): set GVP_EXPECTED_ENV=prod on Amplify app d2ey3rf8zwq2lv (arms the amplify.yml fail-closed guard for future promotions); verify positive smoke path with the prod SMOKE_PROBE_KEY. Deferred: S16 budget alarm, S30 WAF.
