# ADR-0005 — Two-layer TDD harness (app = node:test, chat = pytest)

## Status

Accepted. (Retroactively recorded during the teamentic adoption bootstrap.)

## Context

The repo holds two distinct codebases with different runtimes: the static site +
AWS contact Lambda handlers (JavaScript, under `js/ scripts/ aws/`), and the
Gemini chat/voice backend (Python FastAPI, under `docker/chat/app/`). A single test
command can't cover both cleanly — the Python tree has its own dependency set
(langchain, google-genai) and a much larger suite, and forcing every edit through a
cold Python import would make the TDD loop slow and fragile on machines without a
local Python env.

## Decision

Define **two independently-tested layers** in `.claude/tdd.config`, with `node --test`
as the canonical always-present floor:

- `LAYERS="app chat"` (`.claude/tdd.config:13`).
- **app layer:** `TEST_CMD_app="node --test"` over source `js|scripts|aws`
  (`.claude/tdd.config:22-24`). The session-start floor is `ALL_TEST_CMD="node --test"`
  (`.claude/tdd.config:19`) — "the fast, always-present canonical bar (never regress
  node --test)". The only current node test is
  `test/starfield-reduced-motion.test.mjs` (also exposed as
  `npm run test:reduced-motion`, `package.json:9`).
- **chat layer:** `TEST_CMD_chat="cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q"`
  over source `docker/chat/app/` (`.claude/tdd.config:30-32`). It runs at edit-time
  (PostToolUse) and in CI, mirroring the CI invocation
  (`working-directory: docker/chat`, `PYTHONPATH=.`). Cold start imports langchain
  (~100s once per session); the config keeps the floor node-only on purpose.
- **CI gating:** `.github/workflows/docker-compose-chat-ci.yml` validates/builds the
  compose stack and runs the pytest suite (`working-directory: docker/chat`,
  `PYTHONPATH=. python -m pytest tests -v`, lines 22-37). Green baseline recorded
  2026-06-03: app 10/10 · chat 70/70 (`.claude/tdd.config:11`).

## Consequences

- The split is deliberate and matches the runtime boundary: JS edits are gated by
  node:test, Python edits by pytest, and neither blocks the other.
- **Discrepancy to fix (not in scope for this ADR):** `.claude/tdd.config:9` cites the
  chat CI workflow as `.github/workflows/docker-compose-chat-ci.yml`, which exists and
  is correct. However the seeded `.github/workflows/tdd-verify.yml` is still the
  **unedited teamentic template** — it runs `pnpm install --frozen-lockfile` + `pnpm
  verify` (lines 19-20), but this repo has **no `pnpm-lock.yaml`** and **no `verify`
  npm script** (`package.json:6-16`). That workflow would fail on a clean checkout. The
  real canonical floor is `node --test`; `tdd-verify.yml` should be edited to
  `npm ci || true` + `node --test` (or removed) by the inner loop. Filed as drift; this
  ADR records the intended contract, it does not fix the workflow.
