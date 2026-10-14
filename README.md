# gvp

**Architecture (diagrams):** [`docs/architecture.md`](docs/architecture.md) — system overview, frontend modules, contact/chat flows, deploy topology.

Chat hosting is summarised under [Chat](#chat-cloudfront--two-container-lambdas) below;
`docs/architecture.md` has the full diagrams and the ADR-0022 migration history.

## Local Docker

Run the static site plus mock APIs on a single origin (`http://localhost:8080`).

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080). The nginx proxy serves the repo root read-only and forwards `POST /api/contact` to the mock ingress and `POST /api/chat` to the chat service.

Stop and remove containers:

```bash
docker compose down
```

Smoke checks (requires stack up):

```bash
./scripts/docker-smoke.sh
```

Override the base URL: `DOCKER_SMOKE_URL=http://127.0.0.1:8080 ./scripts/docker-smoke.sh`.

**Chat tests (no Docker required):** from repo root, create a venv under `docker/chat` and run pytest (uses `CHAT_PROVIDER=mock`):

```bash
cd docker/chat && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
PYTHONPATH=. .venv/bin/python -m pytest tests -v
```

**Environment:** The local stack does not require secrets. Optional compose overrides can live in a gitignored `.env` at the repo root; see [`docker/.env.example`](docker/.env.example) for a placeholder. Production and SAM variable names live in [`secrets.example/deploy.env.example`](secrets.example/deploy.env.example).

## Chat (CloudFront + two container Lambdas)

There is no "Lambda vs container" split: **both chat functions are container images**
(`PackageType: Image`) running the **same** FastAPI app, `app.main:app`. One codebase,
three Dockerfiles, differing only in how the app is spoken to.

| image | entry | adapter | serves |
|---|---|---|---|
| [`docker/chat/Dockerfile.lambda-stream`](docker/chat/Dockerfile.lambda-stream) | `uvicorn app.main:app` | **Lambda Web Adapter** extension, `AWS_LWA_INVOKE_MODE=response_stream` | `POST /api/chat` (SSE) |
| [`docker/chat/Dockerfile.lambda`](docker/chat/Dockerfile.lambda) | `app.lambda_handler.handler` | **Mangum**, event → ASGI (buffered) | everything else |
| [`docker/chat/Dockerfile`](docker/chat/Dockerfile) | `uvicorn app.main:app` | none — plain server | local compose only |

Mangum turns a Lambda event into an ASGI call, so no server runs and the whole response
must be assembled before returning — inherently buffered. LWA instead keeps the real
`uvicorn` running inside the container and proxies each invocation to `localhost:8000`,
which is what lets bytes leave as they are produced. Note the streaming image and the
plain image have **identical CMDs**: with LWA the app cannot tell it is on Lambda, which
is why moving off ECS needed no application change.

**Why two functions.** Streaming needs a Lambda **Function URL** — HttpApi buffers, so SSE
through it arrives all at once. But a Function URL has no routing, and anonymous Function
URLs are blocked account-wide here (measured; see the rationale in
[`aws/chat-stream-template.yaml`](aws/chat-stream-template.yaml)), so it must be
`AWS_IAM`. **CloudFront + OAC** (`OriginAccessControlOriginType: lambda`) solves both at
once — it SigV4-signs to the Function URL *and* gives path routing:

- `/api/chat` (and `/api/chat/`) → the streaming Function URL
- default behaviour → the HttpApi on the chat stack

So the split is **streaming vs not**, not Lambda vs container. One consequence: the OAC
signature covers the body hash, so a request must carry `x-amz-content-sha256` — which is
what [`js/chat-payload-hash.js`](js/chat-payload-hash.js) computes in the browser. A
hand-rolled `curl` without that header gets a 403, and anything that serializes the body
twice breaks the front door the same way.

**Voice never touches AWS.** Lambda cannot hold a WebSocket, so it does not try.
`POST /api/live/session` mints a short-lived Gemini **ephemeral token**, and the browser
then opens `wss://generativelanguage.googleapis.com/…BidiGenerateContentConstrained`
**directly** to Google (`liveVoiceTransport = "direct_google"`, hardcoded in
`docker/chat/app/main.py`). The `Constrained` endpoint exists for exactly this
ephemeral-token case. The relay code (`WS /api/live/relay/{id}`) still exists but is
dormant — nothing selects it. This is why ECS Express could be deleted without breaking
voice.

### Deploying chat

The stream target is **not** the default, and the chat stack name must be set **per
environment** or the script refuses:

```bash
CHAT_DEPLOY_TARGET=stream SYNC_API_URLS=0 \
  CHAT_SAM_STACK_NAME_PROD=gvp-chat-prod CHAT_SAM_STACK_NAME_STAGE=gvp-chat-stage \
  bash scripts/integrate-and-deploy.sh stage
```

- **`CHAT_DEPLOY_TARGET=stream`** — `express` is still the default and now deploys nothing
  useful (the ECS services are deleted). An unrecognised value exits 1 rather than
  silently deploying nothing.
- **Both per-env stack names** — the legacy `CHAT_SAM_STACK_NAME` is the fallback for
  *both* arms, so setting only it resolves prod and stage to the same stack. The script
  refuses that rather than writing prod parameters into the stage stack.
- **`SYNC_API_URLS=0`** unless you intend a meta change. The stream target never repoints
  `gvp:chat-api-url` on its own (invariant 11), but an explicit override still reaches the
  committed HTML.

This deploy builds a container image, so it needs a healthy Docker daemon. A wedged Docker
shows up as `sam build` sitting at 0% CPU with no output — restart Docker rather than
waiting.

### Token quota and telemetry

The binding constraint on the free tier is
`GenerateContentInputTokensPerModelPerMinute-FreeTier` = **16,000 input tokens per minute,
per model**. Every turn logs what it spent:

```
gemini usage model=… prompt=7165 cached=4070 cached_pct=57 billable=3095 output=128
```

`billable` is what counts against the quota, so **`16000 / billable` is turns-per-minute**.
Cached input tokens are free, which is why the knowledge blob is ordered so Gemini's
implicit cache can match an identical **prefix** — all static sections (bio, indexes, FAQ)
precede every dynamic one in `serialize_context_xml`. Measured: ordering alone took a turn
from ~6,600 billable to ~2,525.

Two operational traps worth knowing:

- **`cached_pct` dropping to 0 is the alarm.** The prefix sits near the ~4,096-token
  minimum for implicit caching, so a content edit to the bio or indexes can silently push
  it under the floor. Answers stay correct and only the 429 rate moves, so nothing else
  reveals it. `docker/chat/tests/test_cache_prefix.py` pins both the prefix length and the
  static-before-dynamic ordering.
- **The cache is per model, and stage shares prod's API key.** A fallback to
  `GEMINI_FALLBACK_MODEL` always starts cold and pays full price from its own separate
  16,000, and because the quota is per *project*, **load-testing stage degrades prod
  chat**. Separate keys are the fix; there is currently no isolation seam on the model side.

## Contact form (Amplify + AWS durable pipeline)

This repo is a static site hosted on Amplify, with an AWS-native durable contact pipeline used to receive and deliver contact messages.

### Secrets and deploy configuration (single source of truth)

- **Canonical template**: [`secrets.example/deploy.env.example`](secrets.example/deploy.env.example) lists every **name** used for SAM deploy (`export …` in the file body). Copy to **`.secrets/deploy.env`** (gitignored), fill real values, `chmod 600`. See [`secrets.example/README.md`](secrets.example/README.md).
- **Deploy**: [`scripts/integrate-and-deploy.sh`](scripts/integrate-and-deploy.sh) — `bash scripts/integrate-and-deploy.sh` or `… stage`. Omitted argument defaults to **prod** (`SAM_STACK_NAME`, default **`page`**). Loads **`.secrets/deploy.env`** when **`RESEND_API_KEY`** is unset, then optional **`.secrets/chat-deploy.env`**. When **`.secrets/manifest.json`** and **`config.manifest.json`** both exist, the script first runs **Secrets Manager** seed + push (same as the old orchestrate step); set **`SKIP_SECRETS_MANAGER=1`** to skip that (quick redeploys; CI has no manifests so it never runs there). **`chat.marwanelgendy.link`** is the **staging frontend**; **`gvp:chat-api-url`** must target the **chat API** (execute-api URL from optional Lambda stack, ALB, etc.). **Lambda + Gemini (recommended for staging):** set **`CHAT_SAM_STACK_NAME_STAGE`** (stage) / **`CHAT_SAM_STACK_NAME_PROD`** (prod), or legacy **`CHAT_SAM_STACK_NAME`**, plus **`GEMINI_API_KEY`** in [`.secrets/chat-deploy.env`](secrets.example/chat-deploy.env.example) — deploy runs **`aws/chat-template.yaml`** after the contact stack and uses output **`ChatPostApiUrl`** for meta when **`CHAT_STAGE_CHAT_API_URL`** is unset. Pass a real [AI Studio](https://aistudio.google.com/apikey) key at deploy (SAM parameter **`GeminiApiKey`** has no default). **SAM-managed ECS (voice is always on in the FE):** set **`CHAT_ECS_SAM_STACK_NAME_STAGE`** / **`CHAT_ECS_SAM_STACK_NAME_PROD`**, **`GEMINI_API_KEY`**, and VPC + subnet IDs — or rely on the default **`CHAT_VOICE_ECS_BOOTSTRAP=1`** to auto-fill default VPC, subnets, ECR repo, URI, and stack names (`gvp-chat-ecs-{stage,prod}`) (see `chat-deploy.env.example`). Opt out of all ECS auto-wiring (text-only chat on Lambda) with **`CHAT_VOICE_ECS_BOOTSTRAP=0`**. When **HTML sync** is on, **`CHAT_STAGE_CHAT_API_URL`** overrides Lambda output; prod uses **`CHAT_PROD_CHAT_API_URL`** then **`ChatPostApiUrl`** from the same-run chat deploy when set. **Actions → Integrate and deploy** includes **deploy_environment** (`prod` / `stage`). **HTML meta sync:** locally, **`SYNC_API_URLS`** defaults to on unless set to **`0`**; the GitHub Action **sync_api_urls** input defaults to **off** — enable it when you want the workflow to patch **`index.html`** / **`admin/index.html`** and upload the artifact.
- **GitHub Actions**: create repository **secrets** with the **same names** as in `deploy.env.example` (no `export` prefix). Optional **variables**: `AWS_REGION`, `SAM_STACK_NAME`, `SAM_STACK_NAME_STAGE`, **`CHAT_SAM_STACK_NAME`** (fallback when per-env names unset), **`CHAT_SAM_STACK_NAME_STAGE`**, **`CHAT_SAM_STACK_NAME_PROD`**, **`CHAT_CORS_ORIGINS`**, **`GEMINI_MODEL`**, **`GEMINI_FALLBACK_MODEL`** (defaults in code/template to **`gemini-3.1-flash-lite`** + **`gemma-4-26b-a4b-it`**), plus **`CHAT_ECS_SAM_STACK_NAME_STAGE`**, **`CHAT_ECS_SAM_STACK_NAME_PROD`**, **`CHAT_ECS_VPC_ID`**, **`CHAT_ECS_SUBNET_IDS`**, **`CHAT_ECR_REPOSITORY_URI`**, **`CHAT_ECR_REPO_NAME`**, **`CHAT_ECS_CREATE_DEFAULT_VPC`**, **`CHAT_VOICE_ECS_BOOTSTRAP`**, legacy **`CHAT_ECS_CLUSTER_*`** / **`CHAT_ECS_SERVICE_*`**, and other names from `chat-deploy.env.example`. Optional secret **`GEMINI_API_KEY`** for Lambda and ECS chat stacks.
- **Never commit** real keys, `ADMIN_API_KEY`, or production-only values. **`.gitignore`** excludes **`.secrets/`**, `.env*`, credential JSON patterns, and `aws/.env`. Keep [`aws/samconfig.toml`](aws/samconfig.toml) free of secrets; pass parameters via env / `--parameter-overrides` as the scripts do.
- **Public site analytics**: events go to **Google Analytics** from the browser (`js/analytics.js` + gtag in `index.html`). The private **admin** page has tabs for **Contact** (queue health, retries) and **Transcripts** (chat sessions with stream/voice rollups, activity sparkline, recent failures).
- **Contact API URL** is in HTML **`<meta name="gvp:contact-api-url">`**. After deploy, run [`scripts/sync-site-api-urls.mjs`](scripts/sync-site-api-urls.mjs) (or the workflow with **sync_api_urls**) to patch that meta from stack output `ContactApiUrl`.
- Optional chat URL sync uses the same script: `node scripts/sync-site-api-urls.mjs <contactApiUrl> <chatApiUrl>`. The second argument patches **`<meta name="gvp:chat-api-url">`** where present (`index.html`, and `admin/index.html` if that meta exists). **`chatApiUrl`** is the **chat API** (FastAPI `POST /api/chat`), not the staging **site** at **`chat.marwanelgendy.link`** unless that host reverse-proxies `/api/chat` to the container.
- **Browser voice (Gemini Live):** mic UI is **always rendered** in the FE — no meta flag. Voice is **browser-direct** and needs **no WebSocket-capable host**: `POST /api/live/session` mints an ephemeral token and the browser opens Google's Live socket itself (`liveVoiceTransport = "direct_google"`, hardcoded). See [Chat](#chat-cloudfront--two-container-lambdas) above. The relay path (`CHAT_LIVE_RELAY`, `WS /api/live/relay/{id}`) is **dormant** — nothing selects it — and the ECS Express services it was written for were **deleted on 2026-10-13**, so the old "use ECS/ALB for real voice" guidance no longer applies. Optional **`CHAT_LIVE_VOICE_STRICT=1`** still makes **`POST /api/live/session`** return **503** when relay is off. The `CHAT_ECS_*` / `CHAT_VOICE_ECS_BOOTSTRAP` variables below are retained for history only; a stream deploy ignores them.

### What “success” means

- The UI shows success only after the backend has **persisted** the message and queued it for delivery.
- Delivery happens asynchronously through SQS + Lambda, so accepted messages are durable even if Resend is temporarily unavailable.
- Failures are retained, retried, and surfaced through DLQ alarms and report emails.

### One-step integrate and deploy (GitHub Actions)

Use **Actions → Integrate and deploy → Run workflow** (`sam build` / `sam deploy`, optional Lambda chat stack, optional ECS chat image, optional HTML sync). Choose **deploy_environment** `prod` or `stage`. For **stage**, either set **`CHAT_STAGE_CHAT_API_URL`** to a full `…/api/chat` URL, or set **`CHAT_SAM_STACK_NAME_STAGE`** (or **`CHAT_SAM_STACK_NAME`**) + secret **`GEMINI_API_KEY`** so the workflow deploys **`aws/chat-template.yaml`** and can sync meta from **`ChatPostApiUrl`**.

1. **Repository variables** (optional): `AWS_REGION`, `SAM_STACK_NAME`, `SAM_STACK_NAME_STAGE`, **`CHAT_SAM_STACK_NAME`**, **`CHAT_SAM_STACK_NAME_STAGE`**, **`CHAT_SAM_STACK_NAME_PROD`**, **`CHAT_CORS_ORIGINS`**, **`CHAT_STAGE_CHAT_API_URL`**, **`CHAT_PROD_CHAT_API_URL`**, **`CHAT_ECS_AUTO_SYNC_CHAT_URL`**, **`CHAT_LIVE_VOICE_STRICT`**, **`CHAT_ECS_SAM_STACK_NAME_STAGE`**, **`CHAT_ECS_SAM_STACK_NAME_PROD`**, **`CHAT_ECS_VPC_ID`**, **`CHAT_ECS_SUBNET_IDS`**, **`CHAT_ECR_REPOSITORY_URI`**, **`CHAT_ECR_REPO_NAME`**, **`CHAT_ECS_CREATE_DEFAULT_VPC`**, **`CHAT_VOICE_ECS_BOOTSTRAP`**, **`CHAT_ECS_CLUSTER_*`**, **`CHAT_ECS_SERVICE_*`**, and other ECR/ECS names from `chat-deploy.env.example` when used.
2. **Repository secrets** (required for deploy): same names as [`secrets.example/deploy.env.example`](secrets.example/deploy.env.example) — `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, `ALARM_EMAIL`, `ADMIN_API_KEY`; optional `CONTACT_REPORT_EMAIL`. Optional **`GEMINI_API_KEY`** when deploying the Lambda chat stack.
3. **AWS auth** (workflow input): **OIDC** — `AWS_DEPLOY_ROLE_ARN`; or **keys** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
4. **Workflow input** **sync_api_urls**: patches `index.html` and `admin/index.html` and uploads artifact **`site-html-api-urls`**.

### Local deploy (with optional Secrets Manager)

```bash
cp -R secrets.example .secrets
cp secrets.example/deploy.env.example .secrets/deploy.env
# Edit .secrets/deploy.env; optional: manifest.json + config.manifest.json + .secrets/files/
chmod 600 .secrets/deploy.env .secrets/files/* 2>/dev/null || true
bash scripts/integrate-and-deploy.sh
```

Optional **ECS networking** (pin IDs in git or CI): **`npm run chat:discover-env`** prints `export CHAT_ECS_VPC_ID=…`, `CHAT_ECS_SUBNET_IDS=…`, `CHAT_ECR_REPOSITORY_URI=…` (same EC2 logic the deploy script uses when those vars are unset during SAM ECS). Append to `.secrets/chat-deploy.env`, review, `chmod 600`.

With **`manifest.json`** + **`config.manifest.json`** present under **`.secrets/`**, the same command uploads manifest file secrets and seeds config before SAM deploy. Override directory: `SECRETS_DIR=/path/to/.secrets bash scripts/integrate-and-deploy.sh stage`. Skip Secrets Manager prep: `SKIP_SECRETS_MANAGER=1 bash scripts/integrate-and-deploy.sh`.

**IAM** (caller): `secretsmanager:CreateSecret`, `DescribeSecret`, `PutSecretValue` for manifest secret IDs, plus `sam deploy` / CloudFormation permissions.

### AWS setup

- **Infrastructure**: `aws/template.yaml` (SAM). **Lambda npm deps** are declared in `aws/src/package.json`; `sam build` installs them into each function artifact (`npm run sam:build` from repo root).
- **Ingress Lambda**: `aws/src/contact-ingress.js`
- **Sender Lambda**: `aws/src/contact-sender.js`
- **Failure report Lambda**: `aws/src/contact-report.js`
- **Admin Lambda**: `aws/src/contact-admin.js`
- **DynamoDB**: messages table has GSI **`byCreatedAt`** (`listPk` + `createdAt`). New writes set `listPk` to `CONTACT`. **Existing rows** without `listPk` will not appear in the admin message list until you run the one-off **`aws/src/backfill-listpk.js`** (see script header for env vars) after `cd aws/src && npm install`.
- **Frontend route**: `/api/contact` (default when `gvp:contact-api-url` meta is empty), or set meta / `window.__CONTACT_API_URL__` via [`scripts/sync-site-api-urls.mjs`](scripts/sync-site-api-urls.mjs)

### Resend sender verification

Resend requires that the `from` address is verified (domain or sender). Example:

- `CONTACT_FROM_EMAIL=Marwan <no-reply@yourdomain.com>`

### Storage and delivery reporting

- Messages are stored in DynamoDB before delivery is attempted.
- Delivery work is queued in SQS and processed by a sender Lambda.
- Failed deliveries retry automatically through SQS redrive policy.
- Messages that continue to fail end up in a DLQ, trigger CloudWatch alarms, and are included in a scheduled failure report.

### Private admin dashboard

- Static page: `admin/index.html`
- Client: `js/admin.js`
- Styles: `css/admin.css`
- **Contact routes**: `GET /api/contact/admin/summary`, `messages` (supports `?limit`, `?cursor` + JSON `nextCursor` for **Load older messages**), `messages/{id}`, `health`; `POST /api/contact/admin/retry/{id}`, `messages/{id}/suppress-report`
- **Chat transcript routes** (same Lambda): `GET /api/chat/admin/transcripts` (paginated), `transcripts/{id}`, `transcripts/summary` (top-level `stream` + `voice` rollups, `activityByDay`, `recentFailures[]`); `POST /api/chat/admin/transcripts/{id}/note`, `transcripts/{id}/reviewed`
- **Chat host diagnostic** (separate origin, chat ECS task): `GET /api/chat/host-status` returns provider/model info and live `TranscriptStore` counters. Requires `ADMIN_API_KEY` env on the chat container; the admin SPA falls back to DDB-only rollups when unset.
- Auth: header `x-admin-key` matching `ADMIN_API_KEY` from deploy env

Scheduled failure reports (`aws/src/contact-report.js`) only include non-sent messages with `attempts > 0` and **exclude** items where `reportSuppressed` is true.

#### Stream + failure capture (chat)

Every text chat turn (success, error, or timeout) writes a row before the user-visible response returns. Per-turn fields the admin panel renders:

- `stream`, `firstTokenLatencyMs`, `streamChunkCount`, `outputCharCount`, `fallbackUsed`
- `status` (`ok` / `error` / `timeout`), `errorCode`, `errorMessage`
- existing: `latencyMs`, `toolCalls`, `actions`, `retrieval`, `flags`

`transcripts/summary` rolls these up into `streamedSessions`, `streamedTurns`, `streamFailures`, `streamTimeouts`, `fallbackTurns`, `avgFirstTokenLatencyMs`, `avgOutputChars`, `errorsByCode`, and the 20 most-recent `recentFailures[]` (clickable in the panel to jump to the transcript).
