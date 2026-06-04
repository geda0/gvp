# Releases

_Owned by the project-manager. One row per release — recorded only after health is
verified. Never release on a red bar or unaccepted work._

| Milestone | Commit | Tag | Environment | Health | Date |
|-----------|--------|-----|-------------|--------|------|
| Staging CI/CD pipeline completed + verified | `b099019` (agent) · deploy run `26929994505` | — | **staging** | **GREEN end-to-end.** New `deploy-staging.yml` (push→agent, path-filtered, test-gated) ran `integrate-and-deploy.sh stage` via OIDC role `gvp-staging-ci-deploy`. Deployed **contact `page-staging`** (`fvfqpef8kb…` — matches the frontend's contact meta ✓) + **chat Lambda `gvp-chat-stage`** (`m7qmz78kb6…`). Health: chat /health+/ready 200, contact OPTIONS 204. Frontend (Amplify) serves `chat.marwanelgendy.link`. | 2026-06-04 |
| Chat topology resolved → CI is contact-only | — | — | staging | Navigator chose **contact-only CI; chat stays manual (ECS)**. Removed the `CHAT_SAM_STACK_NAME` repo var (CI deploys only `page-staging`) and **tightened** the `gvp-staging-ci-deploy` IAM policy to contact-only (dropped ECR + chat scopes). **Tore down the orphaned** `gvp-chat-stage` + `*-CompanionStack` + its companion ECR repo. PRESERVED: `gvp-chat` (ECS voice repo), `page-staging`, the SAM bucket. Frontend chat keeps using the ECS `chat-api-stage…`. | 2026-06-04 |
| Staging deploy (contact-only) + team-tactics 0.8.5 | `8f4584c` (agent) · deploy run `26936642631` | — | **staging** | **GREEN** (test ✅ + deploy ✅, 55s). First contact-only run via the tightened `gvp-staging-ci-deploy` role. `page-staging` ContactApiUrl `fvfqpef8kb…` OPTIONS 204 (matches FE meta); frontend `chat.marwanelgendy.link` 200; ECS chat `chat-api-stage` 200 (untouched). 0.8.5 merged onto agent. ⚠ CI uses Node20 actions (GitHub deprecation 2026-06-16). | 2026-06-04 |
