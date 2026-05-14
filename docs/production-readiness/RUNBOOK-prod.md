# Production runbook

## Scope

Deploy and verify:

- static portfolio site
- AWS contact pipeline (existing SAM stack)
- chat backend service (separate deployable)

## Deploy order

1. **Backend chat deploy**
   - Deploy chat container/service.
   - Verify chat health endpoint and provider configuration.
2. **Platform/edge updates**
   - Apply proxy/routing rules for `/api/chat` if using same-origin proxy.
   - Confirm TLS termination and expected hostnames.
3. **Static site deploy**
   - Publish static assets.
   - Ensure `gvp:contact-api-url` and `gvp:chat-api-url` are correct for the target environment.
4. **Contact pipeline deploy (if changed)**
   - Run existing SAM deploy flow via [`scripts/integrate-and-deploy.sh`](../../scripts/integrate-and-deploy.sh).

## URLs to set/verify

- `gvp:contact-api-url` in [index.html](../../index.html)
- `gvp:chat-api-url` in [index.html](../../index.html)
- (optional) admin contact meta if deployment policy requires it

## Smoke checks

1. Open site root and verify hero loads correctly.
2. Submit contact form and confirm success response.
3. Send at least two chat prompts:
   - one in-corpus portfolio question
   - one out-of-scope question (refusal policy)
4. Verify navigation and theme toggle still work.
5. Run local compose smoke where relevant: [`scripts/docker-smoke.sh`](../../scripts/docker-smoke.sh)

## Rollback

1. Revert static hosting to previous artifact/deployment.
2. Roll back chat service image to prior known-good tag.
3. Re-apply prior routing/meta values for chat/contact URLs.
4. Re-run smoke checks and document incident notes.

## Release notes

### 2026-05-13

- Established multi-team execution structure under [docs/teams/README.md](../teams/README.md).
- Added explicit production dependency order in [README.md](./README.md).
- Created this runbook as the release coordinator execution target.
