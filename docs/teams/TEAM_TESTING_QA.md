# Team Testing/QA

**Mission:** verify chatbot correctness, speed, and UX stability end-to-end with repeatable checks.

**Primary ownership**

- [docker/chat/tests/test_api.py](../../docker/chat/tests/test_api.py)
- [docker/chat/tests/conftest.py](../../docker/chat/tests/conftest.py)
- [scripts/docker-smoke.sh](../../scripts/docker-smoke.sh)
- [package.json](../../package.json) (existing reduced-motion test script)

## Test streams

### 1) API correctness and robustness

- Expand chat API tests toward the matrix from [docs/parallel-phases/TEAM_CHATBOT.md](../parallel-phases/TEAM_CHATBOT.md):
  - multi-turn behavior
  - out-of-corpus refusal behavior
  - oversized payload handling
  - provider-misconfiguration paths
  - concurrent request stability

### 2) UX and hero behavior

- Manual acceptance for [index.html](../../index.html), [js/chat.js](../../js/chat.js), and [css/chat.css](../../css/chat.css):
  - space/garden parity
  - keyboard behavior
  - error and retry handling
  - no regressions in contact dialog and navigation

### 3) Integration smoke and CI confidence

- Maintain/update [scripts/docker-smoke.sh](../../scripts/docker-smoke.sh).
- Keep `npm run test:reduced-motion` passing.
- Add CI jobs proposed by Team Pipeline as checks become stable.

## Worker prompt

```text
You are Team Testing/QA in /Users/marwanelgendy/workspace/PP/gvp.
Work in docker/chat/tests, scripts/docker-smoke.sh, and CI workflow files as needed.
Add high-signal tests for correctness and resilience without brittle snapshots.
Ensure existing tests remain green and keep test runtime practical for CI.
```

## Definition of done

- [ ] Core chatbot tests cover correctness + failure paths.
- [ ] UI/UX verification checklist documented and executed.
- [ ] Smoke script remains representative of expected local/prod-like behavior.
- [ ] Test outcomes are easy to run locally and in CI.
