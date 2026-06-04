# Releases

_Owned by the project-manager. One row per release — recorded only after health is
verified. Never release on a red bar or unaccepted work._

| Milestone | Commit | Tag | Environment | Health | Date |
|-----------|--------|-----|-------------|--------|------|
| TDD work (contact #3/#4/#5 + chat #7/#8) + team-tactics 0.8.0 → staging | `514f938` (merge of `claude/compassionate-dubinsky-de3583` into `agent`) | — | **staging** (Amplify, `agent` branch → `chat.marwanelgendy.link`) | suites green pre-push (app 23/23 · chat 75/75); `chat.marwanelgendy.link` reachable + serving the portfolio. Amplify build async — confirm new build in the Amplify console. **Frontend unchanged by this merge** (work is backend/tests/docs/harness); staging API URLs preserved. **Backend Lambdas NOT auto-deployed** — the refactored contact Lambdas reach staging only via a separate `integrate-and-deploy.sh stage` / `workflow_dispatch` run. | 2026-06-04 |
