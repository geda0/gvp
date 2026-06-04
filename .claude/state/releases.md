# Releases

_Owned by the project-manager. One row per release — recorded only after health is
verified. Never release on a red bar or unaccepted work._

| Milestone | Commit | Tag | Environment | Health | Date |
|-----------|--------|-----|-------------|--------|------|
| Staging CI/CD pipeline completed + verified | `b099019` (agent) · deploy run `26929994505` | — | **staging** | **GREEN end-to-end.** New `deploy-staging.yml` (push→agent, path-filtered, test-gated) ran `integrate-and-deploy.sh stage` via OIDC role `gvp-staging-ci-deploy`. Deployed **contact `page-staging`** (`fvfqpef8kb…` — matches the frontend's contact meta ✓) + **chat Lambda `gvp-chat-stage`** (`m7qmz78kb6…`). Health: chat /health+/ready 200, contact OPTIONS 204. Frontend (Amplify) serves `chat.marwanelgendy.link`. | 2026-06-04 |
| ⚠ Chat topology caveat | — | — | staging | The frontend's chat meta points at `chat-api-stage.marwanelgendy.link` (**ECS/ALB**, voice — live, separate), NOT the CI-deployed **Lambda** (`m7qmz78kb6`). CI's chat Lambda is currently **orphaned** w.r.t. the frontend (CHAT_VOICE_ECS_BOOTSTRAP=0). Contact is fully wired; chat-deploy-via-CI needs a decision (ECS vs Lambda+repoint vs contact-only). | 2026-06-04 |
