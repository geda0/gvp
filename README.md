# gvp

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

## Contact form (Amplify + AWS durable pipeline)

This repo is a static site hosted on Amplify, with an AWS-native durable contact pipeline used to receive and deliver contact messages.

### Secrets and deploy configuration (single source of truth)

- **Canonical template**: [`secrets.example/deploy.env.example`](secrets.example/deploy.env.example) lists every **name** used for SAM deploy (`export …` in the file body). Copy to **`.secrets/deploy.env`** (gitignored), fill real values, `chmod 600`. See [`secrets.example/README.md`](secrets.example/README.md).
- **Deploy**: [`scripts/integrate-and-deploy.sh`](scripts/integrate-and-deploy.sh) — `bash scripts/integrate-and-deploy.sh` or `… stage`. Omitted argument defaults to **prod** (`SAM_STACK_NAME`, default **`page`**). Loads **`.secrets/deploy.env`** when **`RESEND_API_KEY`** is unset, then optional **`.secrets/chat-deploy.env`**. When **`.secrets/manifest.json`** and **`config.manifest.json`** both exist, the script first runs **Secrets Manager** seed + push (same as the old orchestrate step); set **`SKIP_SECRETS_MANAGER=1`** to skip that (quick redeploys; CI has no manifests so it never runs there). **`chat.marwanelgendy.link`** is the **staging frontend**; **`gvp:chat-api-url`** must target the **chat API** (execute-api URL from optional Lambda stack, ALB, etc.). **Lambda + Gemini (recommended for staging):** set **`CHAT_SAM_STACK_NAME_STAGE`** (stage) / **`CHAT_SAM_STACK_NAME_PROD`** (prod), or legacy **`CHAT_SAM_STACK_NAME`**, plus **`GEMINI_API_KEY`** in [`.secrets/chat-deploy.env`](secrets.example/chat-deploy.env.example) — deploy runs **`aws/chat-template.yaml`** after the contact stack and uses output **`ChatPostApiUrl`** for meta when **`CHAT_STAGE_CHAT_API_URL`** is unset. Pass a real [AI Studio](https://aistudio.google.com/apikey) key at deploy (SAM parameter **`GeminiApiKey`** has no default). When **HTML sync** is on, **`CHAT_STAGE_CHAT_API_URL`** overrides that output; prod uses **`CHAT_PROD_CHAT_API_URL`** then **`ChatPostApiUrl`** from the same-run chat deploy when set. **Actions → Integrate and deploy** includes **deploy_environment** (`prod` / `stage`). **HTML meta sync:** locally, **`SYNC_API_URLS`** defaults to on unless set to **`0`**; the GitHub Action **sync_api_urls** input defaults to **off** — enable it when you want the workflow to patch **`index.html`** / **`admin/index.html`** and upload the artifact.
- **GitHub Actions**: create repository **secrets** with the **same names** as in `deploy.env.example` (no `export` prefix). Optional **variables**: `AWS_REGION`, `SAM_STACK_NAME`, `SAM_STACK_NAME_STAGE`, **`CHAT_SAM_STACK_NAME`** (fallback when per-env names unset), **`CHAT_SAM_STACK_NAME_STAGE`**, **`CHAT_SAM_STACK_NAME_PROD`**, **`CHAT_CORS_ORIGINS`**, **`GEMINI_MODEL`**, **`GEMINI_FALLBACK_MODEL`** (defaults in code/template to **`gemini-3.1-flash-lite`** + **`gemma-4-26b-a4b-it`**), plus chat/ECR/ECS names from `chat-deploy.env.example`. Optional secret **`GEMINI_API_KEY`** for the Lambda chat stack.
- **Never commit** real keys, `ADMIN_API_KEY`, or production-only values. **`.gitignore`** excludes **`.secrets/`**, `.env*`, credential JSON patterns, and `aws/.env`. Keep [`aws/samconfig.toml`](aws/samconfig.toml) free of secrets; pass parameters via env / `--parameter-overrides` as the scripts do.
- **Public site analytics**: events go to **Google Analytics** from the browser (`js/analytics.js` + gtag in `index.html`). The private **admin** page is contact-only.
- **Contact API URL** is in HTML **`<meta name="gvp:contact-api-url">`**. After deploy, run [`scripts/sync-site-api-urls.mjs`](scripts/sync-site-api-urls.mjs) (or the workflow with **sync_api_urls**) to patch that meta from stack output `ContactApiUrl`.
- Optional chat URL sync uses the same script: `node scripts/sync-site-api-urls.mjs <contactApiUrl> <chatApiUrl>`. The second argument patches **`<meta name="gvp:chat-api-url">`** where present (`index.html`, and `admin/index.html` if that meta exists). **`chatApiUrl`** is the **chat API** (FastAPI `POST /api/chat`), not the staging **site** at **`chat.marwanelgendy.link`** unless that host reverse-proxies `/api/chat` to the container.
- **Browser voice (Gemini Live):** needs a **WebSocket-capable** chat host with **`CHAT_LIVE_RELAY=1`** (default in [`docker/chat/Dockerfile`](docker/chat/Dockerfile) for ECS images). API Gateway HTTP API + Lambda uses **`CHAT_LIVE_RELAY=0`** in [`aws/chat-template.yaml`](aws/chat-template.yaml); voice from the browser then hits Google directly and typically fails (close **1011**). For working mic, deploy the chat container on **ECS/ALB** (see [`secrets.example/chat-deploy.env.example`](secrets.example/chat-deploy.env.example)). **`integrate-and-deploy.sh`** patches **`gvp:chat-api-url`** using **`CHAT_PROD_CHAT_API_URL`** / **`CHAT_STAGE_CHAT_API_URL`** when set; if they are unset, it **derives** `https://<ALB-DNS>/api/chat` from **`CHAT_ECS_*` cluster + service** (opt out: **`CHAT_ECS_AUTO_SYNC_CHAT_URL=0`**).

### What “success” means

- The UI shows success only after the backend has **persisted** the message and queued it for delivery.
- Delivery happens asynchronously through SQS + Lambda, so accepted messages are durable even if Resend is temporarily unavailable.
- Failures are retained, retried, and surfaced through DLQ alarms and report emails.

### One-step integrate and deploy (GitHub Actions)

Use **Actions → Integrate and deploy → Run workflow** (`sam build` / `sam deploy`, optional Lambda chat stack, optional ECS chat image, optional HTML sync). Choose **deploy_environment** `prod` or `stage`. For **stage**, either set **`CHAT_STAGE_CHAT_API_URL`** to a full `…/api/chat` URL, or set **`CHAT_SAM_STACK_NAME_STAGE`** (or **`CHAT_SAM_STACK_NAME`**) + secret **`GEMINI_API_KEY`** so the workflow deploys **`aws/chat-template.yaml`** and can sync meta from **`ChatPostApiUrl`**.

1. **Repository variables** (optional): `AWS_REGION`, `SAM_STACK_NAME`, `SAM_STACK_NAME_STAGE`, **`CHAT_SAM_STACK_NAME`**, **`CHAT_SAM_STACK_NAME_STAGE`**, **`CHAT_SAM_STACK_NAME_PROD`**, **`CHAT_CORS_ORIGINS`**, **`CHAT_STAGE_CHAT_API_URL`**, **`CHAT_PROD_CHAT_API_URL`**, plus ECR/ECS names from `chat-deploy.env.example` when used.
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
- API routes: `GET /api/contact/admin/summary`, `messages` (supports `?limit`, `?cursor` + JSON `nextCursor` for **Load older messages**), `messages/{id}`, `health`; `POST /api/contact/admin/retry/{id}`, `messages/{id}/suppress-report`
- Auth: header `x-admin-key` matching `ADMIN_API_KEY` from deploy env

Scheduled failure reports (`aws/src/contact-report.js`) only include non-sent messages with `attempts > 0` and **exclude** items where `reportSuppressed` is true.
