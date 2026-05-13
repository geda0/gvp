# gvp

## Contact form (Amplify + AWS durable pipeline)

This repo is a static site hosted on Amplify, with an AWS-native durable contact pipeline used to receive and deliver contact messages.

### Secrets and deploy configuration (single source of truth)

- **Canonical template**: [`secrets.example/deploy.env.example`](secrets.example/deploy.env.example) lists every **name** used for SAM deploy (`export …` in the file body). Copy to **`.secrets/deploy.env`** (gitignored), fill real values, `chmod 600`. See [`secrets.example/README.md`](secrets.example/README.md).
- **Local full pipeline**: [`scripts/orchestrate-deploy.sh`](scripts/orchestrate-deploy.sh) — seeds `config.manifest.json`, pushes optional file secrets from `manifest.json` to AWS Secrets Manager, sources `.secrets/deploy.env` + generated files, then runs [`scripts/integrate-and-deploy.sh`](scripts/integrate-and-deploy.sh).
- **Deploy script only**: `bash scripts/integrate-and-deploy.sh` — if `RESEND_API_KEY` is not already in the environment, it automatically loads **`.secrets/deploy.env`** (and `config.generated.env` / `deploy.generated.env` when present). Same script runs in CI with variables injected from GitHub.
- **GitHub Actions**: create repository **secrets** with the **same names** as in `deploy.env.example` (no `export` prefix). Optional **variables**: `AWS_REGION`, `SAM_STACK_NAME` (defaults match the example file).
- **Never commit** real keys, `ADMIN_API_KEY`, or production-only values. **`.gitignore`** excludes **`.secrets/`**, `.env*`, credential JSON patterns, and `aws/.env`. Keep [`aws/samconfig.toml`](aws/samconfig.toml) free of secrets; pass parameters via env / `--parameter-overrides` as the scripts do.
- **Public site analytics**: events go to **Google Analytics** from the browser (`js/analytics.js` + gtag in `index.html`). The private **admin** page is contact-only.
- **Contact API URL** is in HTML **`<meta name="gvp:contact-api-url">`**. After deploy, run [`scripts/sync-site-api-urls.mjs`](scripts/sync-site-api-urls.mjs) (or the workflow with **sync_api_urls**) to patch that meta from stack output `ContactApiUrl`.

### What “success” means

- The UI shows success only after the backend has **persisted** the message and queued it for delivery.
- Delivery happens asynchronously through SQS + Lambda, so accepted messages are durable even if Resend is temporarily unavailable.
- Failures are retained, retried, and surfaced through DLQ alarms and report emails.

### One-step integrate and deploy (GitHub Actions)

Use **Actions → Integrate and deploy → Run workflow** (`sam build` / `sam deploy`, optional HTML sync).

1. **Repository variables** (optional): `AWS_REGION` (default `us-east-2`), `SAM_STACK_NAME` (default `page`).
2. **Repository secrets** (required for deploy): same names as [`secrets.example/deploy.env.example`](secrets.example/deploy.env.example) — `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, `ALARM_EMAIL`, `ADMIN_API_KEY`; optional `CONTACT_REPORT_EMAIL`.
3. **AWS auth** (workflow input): **OIDC** — `AWS_DEPLOY_ROLE_ARN`; or **keys** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
4. **Workflow input** **sync_api_urls**: patches `index.html` and `admin/index.html` and uploads artifact **`site-html-api-urls`**.

### Local orchestrated deploy

```bash
cp -R secrets.example .secrets
cp secrets.example/deploy.env.example .secrets/deploy.env
# Edit .secrets/deploy.env; optional: manifest.json + .secrets/files/
chmod 600 .secrets/deploy.env .secrets/files/* 2>/dev/null || true
bash scripts/orchestrate-deploy.sh
```

Override directory: `SECRETS_DIR=/path/to/.secrets bash scripts/orchestrate-deploy.sh`.

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
