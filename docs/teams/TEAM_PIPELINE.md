# Team Pipeline

**Mission:** automate correctness and release safety across chat, static site, and Docker integration.

## Primary ownership

- [.github/workflows/](../../.github/workflows/)
- [scripts/sync-site-api-urls.mjs](../../scripts/sync-site-api-urls.mjs)
- [scripts/integrate-and-deploy.sh](../../scripts/integrate-and-deploy.sh)
- [docker-compose.yml](../../docker-compose.yml) (validation contract)

## Workstreams

### 1) Docker CI baseline

- Add/extend workflow to run:
  - `docker compose config`
  - `docker compose build`

### 2) Chat test CI lane

- Add lane for:
  - `cd docker/chat`
  - create venv
  - `pytest`

### 3) Meta sync automation

- Extend [scripts/sync-site-api-urls.mjs](../../scripts/sync-site-api-urls.mjs) to support chat URL updates, or add companion script.
- Wire script usage to deploy flow in [scripts/integrate-and-deploy.sh](../../scripts/integrate-and-deploy.sh) when env vars are provided.

## Worker prompt

```text
You are Team Pipeline in /Users/marwanelgendy/workspace/PP/gvp.
Work in .github/workflows and scripts/* deployment/sync files.
Implement CI checks for compose and chat tests, and automate contact+chat meta URL sync.
Keep secrets out of repo and preserve existing SAM deploy behavior.
```

## Definition of done

- [ ] CI validates compose config/build.
- [ ] CI executes chat tests in a reproducible lane.
- [ ] Chat API URL sync path is documented and automated.
- [ ] Existing deployment scripts still work for contact SAM pipeline.
