# Releases

_Owned by the project-manager. One row per release — recorded only after health is
verified. Never release on a red bar or unaccepted work._

| Milestone | Commit | Tag | Environment | Health | Date |
|-----------|--------|-----|-------------|--------|------|
| **PRODUCTION** Team Tactics contact CTA (private repo → contact form) | `d9ce997` (main) · deploy run `27051407724` | — | **prod** | **GREEN** (test ✅ + deploy ✅). Merge agent→main preserving prod API metas (`lwi0vmdpb5…` contact, `gv-0277…` chat Express). Labs **Request access** opens prefilled contact dialog; no public GitHub link. Staging qa-verifier PASS before promote. Amplify rebuild of `main` → `www.marwanelgendy.link`. Contact SAM `page` UPDATE_COMPLETE; prod chat ECS untouched. | 2026-06-06 | | `b099019` (agent) · deploy run `26929994505` | — | **staging** | **GREEN end-to-end.** New `deploy-staging.yml` (push→agent, path-filtered, test-gated) ran `integrate-and-deploy.sh stage` via OIDC role `gvp-staging-ci-deploy`. Deployed **contact `page-staging`** (`fvfqpef8kb…` — matches the frontend's contact meta ✓) + **chat Lambda `gvp-chat-stage`** (`m7qmz78kb6…`). Health: chat /health+/ready 200, contact OPTIONS 204. Frontend (Amplify) serves `chat.marwanelgendy.link`. | 2026-06-04 |
| Chat topology resolved → CI is contact-only | — | — | staging | Navigator chose **contact-only CI; chat stays manual (ECS)**. Removed the `CHAT_SAM_STACK_NAME` repo var (CI deploys only `page-staging`) and **tightened** the `gvp-staging-ci-deploy` IAM policy to contact-only (dropped ECR + chat scopes). **Tore down the orphaned** `gvp-chat-stage` + `*-CompanionStack` + its companion ECR repo. PRESERVED: `gvp-chat` (ECS voice repo), `page-staging`, the SAM bucket. Frontend chat keeps using the ECS `chat-api-stage…`. | 2026-06-04 |
| Staging deploy (contact-only) + team-tactics 0.8.5 | `8f4584c` (agent) · deploy run `26936642631` | — | **staging** | **GREEN** (test ✅ + deploy ✅, 55s). First contact-only run via the tightened `gvp-staging-ci-deploy` role. `page-staging` ContactApiUrl `fvfqpef8kb…` OPTIONS 204 (matches FE meta); frontend `chat.marwanelgendy.link` 200; ECS chat `chat-api-stage` 200 (untouched). 0.8.5 merged onto agent. ⚠ CI uses Node20 actions (GitHub deprecation 2026-06-16). | 2026-06-04 |
| **PRODUCTION deploy** (contact refactor → prod) | `fda626f` (main) · deploy run `26938125929` | — | **prod** | **GREEN** (test ✅ + deploy ✅, 1m23s). New `deploy-prod.yml` (push→main, test-gated) ran `integrate-and-deploy.sh prod` via OIDC role `gvp-prod-ci-deploy` (main-only, page-scoped). QA-gated by a staging E2E contact submission (qa-verifier PASS). `page` UPDATE_COMPLETE; contact `lwi0vmdpb5…` OPTIONS 204 (matches FE prod meta); `www.marwanelgendy.link` 200; prod chat ECS `chat-api.marwanelgendy.link` 200 (untouched). Frontend unchanged (Amplify rebuild of `main`). | 2026-06-04 |



## 2026-10-24 — PROMOTED TO PROD: barge-in restored + chat latency budget (ADR-0026) + Track C
- `main` @ `fc73871` (merge of `agent` @ `c37db15`, prod hosts kept). Released on the navigator's
  explicit override of `tics gate` (PO po-1024 and QA qa-1024 ruled concerns; follow-ups F1-F6).
- `deploy-prod` run 40125024040 GREEN; post-deploy warm `POST dlkbine9cip5c… {"warm":true} -> 204 in 5678 ms`.
- Verified live on www:
  - frontend serves `js/chat-prewarm.js` (byte-identical), `js/mic-attach-plan.js` 404;
  - text chat first token 1.0-1.8 s over 4 turns (this morning: 11 s cold, p90 9.2 s);
  - voice probe (WebAudio-fed WAV, real Live API): 38/39 — voice cuts the greeting at the server
    (`interrupted`@7111 before turnComplete@7273), silent control uninterrupted, chip/two-chip/voice-chip
    journeys hold; the 1 FAIL is the known probe reply-window bug (F4), not the product.
- Open: F1 owner first-visit + real-speaker/echo check; F2/F3 pip-layer reuse and 5.4 s post-deploy cold;
  O1 prod Gemini key tier; O2 replacement fallback model.

## 2026-10-23 — PROMOTED TO PROD: star pacing (GREEN, verified live)
- `main` `5aa075d`: merged agent into main (no fast-forward). Prod hosts kept; prod guard 3/3;
  suite 524/0; both CI runs on main GREEN.
- Change: the sky draws at most 60fps, slower frames step by real elapsed time (cap 3x),
  stars move at 0.8x, and density uses a fixed 4-core reference (no longer tracks the CPU).
- Prod served the new build about 2.75 min after the push, with the prod API hosts in the
  meta tags. The night frame measured 493 lit / 21 bright (4-core density on an 8-core
  capture machine).
- `agent` took main back in; stage hosts re-pinned in `2f8475e`.

## 2026-10-23 — PROMOTED TO PROD: original starfield restored (GREEN, verified live)
- `main` `fa6cf19`: merged agent into main (no fast-forward). Prod hosts were kept in
  `index.html` and `admin/index.html`; the prod guard passed 3/3 and the suite 518/0.
- CI on main: tdd-verify and the chat tests are GREEN. Amplify served the new build about
  2.5 min after the push: `js/starfield-geom.js` returns 404, and none of the removed
  identifiers are in the served `starfield.js`.
- A prod 1440x900 night frame composited over #141926 measured 1080 lit / 32 bright. The
  original is 921–1073 / 26–31.
- `agent` took main back in (`f05d6ba`); stage hosts were re-pinned in `1e8ac92`.

## 2026-10-23 — PROMOTED TO PROD: M4, M5, M7, M8 (GREEN, verified live)
- `main`:
  - `4118aa3` merge agent → main (no fast-forward); prod hosts were kept by the merge, so no
    re-pin was needed;
  - `939354e` privacy-link HOLD (ADR-0021 D4);
  - `521221c` deploy fixes;
  - `fde6f98` hold lifted.
- First `deploy-prod` failed at the new WAF stack: WAFv2 rejected the Description's `§` and
  parentheses. The same run would have deployed the chat CDN in GATE MODE (no
  `CHAT_SAM_STACK_NAME_*` in CI).
  - Fixed in `67db0ad`: ASCII description, keep the CDN's existing default origin, delete an
    empty ROLLBACK_COMPLETE WAF stack before retrying.
  - Repo vars `CHAT_SAM_STACK_NAME_PROD=gvp-chat-prod` and `CHAT_SAM_STACK_NAME_STAGE=gvp-chat-stage`
    were set, so CI now also deploys the HttpApi chat stacks.
- `deploy-prod` run 40008189011 GREEN:
  - page (no changes), gvp-chat-prod, gvp-chat-lambda-stream-prod, gvp-chat-waf-prod
    (created in us-east-1), gvp-chat-stream-cdn-prod (WAF attached, default origin kept at
    `63omz2jyqd…`);
  - stream `/health` 200.
- Verified on prod:
  - TTL ENABLED on page-ChatTranscriptsTable, and a fresh row stamped `ttl` +180 days
    (prompt 1.6.0);
  - budgets gvp-lambda-monthly $15 and gvp-account-monthly $70 exist;
  - five stream alarms and the page P1/P2 site alarms exist;
  - in a real browser on www: privacy note (7 facts), "Open the Apptio project" → button →
    the card opens and the chat docks, zero CSP violations, no console errors.
- Noted: the first prod witness turn hit a transient Gemini `500 INTERNAL`. Cold prod Lambda
  took ~15 s on the first browser turn.
- `agent` took main back in and re-pinned the stage hosts.

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

## 2026-06-17 — Consent gate REMOVED → staging + prod (owner: no consent needed)
- SEC-1 reversed. Removed consent banner + GA/beacon gating; deleted js/consent.js + test/consent-gate.test.mjs; analytics + beacon fire unconditionally as before. ipHash HMAC (SEC-2) unaffected.
- agent `473fcb8`; main merge `da62cad` (clean 3-way, prod hosts preserved, env-guard=prod 3/3). FE-only → SAM deploy workflows path-filtered (didn't run, correct); Amplify rebuilt FE (prod build job 243).
- Verified: js/consent.js → 404 on staging + prod; analytics.js no consent ref; www 200; no staging leak. ADR-0008 status updated (SEC-1 reversed, retained for history).
