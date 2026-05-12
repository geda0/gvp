# gvp

## Contact form (Amplify + AWS durable pipeline)

This repo is a static site hosted on Amplify, with an AWS-native durable contact pipeline used to receive and deliver contact messages.

### Secrets and public site config

- **Never commit** Resend keys, `ADMIN_API_KEY`, GCP service-account JSON, or production API URLs. Use **GitHub Actions secrets** (and optional **variables**) for deploy; use **`.env`** locally (gitignored; start from [`.env.example`](.env.example)). For a **single local command** that pushes file-based secrets to **AWS Secrets Manager** then deploys, use **`.secrets/`** + [`scripts/orchestrate-deploy.sh`](scripts/orchestrate-deploy.sh) (see below).
- **Contact API URL** and optional **Looker embed** live in HTML **`<meta>`** tags (`gvp:contact-api-url`, `gvp:traffic-report-embed-url`), not inline secrets. After deploy, run [`scripts/sync-site-api-urls.mjs`](scripts/sync-site-api-urls.mjs) (or the integrate workflow with **sync_api_urls**) to write those metas from `ContactApiUrl` and optional `TRAFFIC_REPORT_EMBED_URL`.
- **`.gitignore`** excludes `.env*`, **`.secrets/`**, credential JSON patterns, and `aws/.env`. Keep `samconfig.toml` free of real emails; pass parameters via the deploy script or `sam deploy --parameter-overrides`.

### What “success” means

- The UI shows success only after the backend has **persisted** the message and queued it for delivery.
- Delivery happens asynchronously through SQS + Lambda, so accepted messages are durable even if Resend is temporarily unavailable.
- Failures are retained, retried, and surfaced through DLQ alarms and report emails.

### One-step integrate and deploy (GitHub Actions)

Use **Actions → Integrate and deploy → Run workflow** (single job: optional BigQuery secret upsert, `sam build` / `sam deploy`, optional HTML sync). Linking GA4 to BigQuery and creating the GCP service account remain **one-time** steps in Google Cloud / GA4 admin; this workflow automates AWS deploy and optional secret/HTML wiring.

1. **Repository variables** (Settings → Secrets and variables → Actions → Variables), optional:
   - `AWS_REGION` (default `us-east-2`)
   - `SAM_STACK_NAME` (default `page`, must match your CloudFormation stack)
   - `TRAFFIC_SECRET_NAME` (default `gvp/ga4-bq-reader` when creating the GCP reader secret from JSON)

2. **Repository secrets** (Actions → Secrets), required for every deploy:
   - `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, `ALARM_EMAIL`, `ADMIN_API_KEY`
   - **AWS auth (pick one path in the workflow UI)**:
     - **OIDC**: `AWS_DEPLOY_ROLE_ARN` (IAM role trust: `token.actions.githubusercontent.com` → this repo). Workflow input **aws_auth** = `oidc`.
     - **Access keys**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Workflow input **aws_auth** = `keys`.

3. **Traffic / BigQuery (optional)**  
   - `TRAFFIC_GCP_PROJECT_ID`, `TRAFFIC_BIGQUERY_DATASET`  
   - `TRAFFIC_GA4_PROPERTY_ID` (optional but recommended; enables live GA4 Data API fallback when BigQuery export is stale/unavailable)
   - Either `TRAFFIC_SERVICE_ACCOUNT_SECRET_ARN` **or** `GCP_SERVICE_ACCOUNT_JSON` (full service-account JSON; the script upserts Secrets Manager and passes the ARN automatically).

4. **Optional Looker embed (admin iframe)**  
   - Repository secret `TRAFFIC_REPORT_EMBED_URL`: passed to the sync step when **sync_api_urls** is enabled (written to `gvp:traffic-report-embed-url` meta on `admin/index.html` only).

5. **Workflow inputs**
   - **sync_api_urls**: if enabled, patches `index.html` and `admin/index.html` metas in the runner and uploads artifact **`site-html-api-urls`** (commit or copy into Amplify manually).

Local equivalent (after `aws login` / `AWS_PROFILE`):

```bash
export RESEND_API_KEY=... CONTACT_TO_EMAIL=... CONTACT_FROM_EMAIL=... ALARM_EMAIL=... ADMIN_API_KEY=...
# optional traffic + auto secret:
export TRAFFIC_GCP_PROJECT_ID=... TRAFFIC_BIGQUERY_DATASET=... TRAFFIC_GA4_PROPERTY_ID=... GCP_SERVICE_ACCOUNT_JSON="$(cat sa.json)"
# optional: patch HTML after deploy
export SYNC_API_URLS=1
# optional: export TRAFFIC_REPORT_EMBED_URL='https://lookerstudio.google.com/embed/...'
bash scripts/integrate-and-deploy.sh
```

### Local orchestrated deploy (`.secrets` → Secrets Manager → SAM)

One local entrypoint seeds config + pushes **gitignored** files into **AWS Secrets Manager** (per [`secrets.example/config.manifest.json`](secrets.example/config.manifest.json) and [`secrets.example/manifest.json`](secrets.example/manifest.json)), writes generated env files, loads them with `.secrets/deploy.env`, then runs the same SAM pipeline as CI:

```bash
cp -R secrets.example .secrets
cp secrets.example/deploy.env.example .secrets/deploy.env
# Add .secrets/files/gcp-sa.json (BigQuery reader), edit .secrets/deploy.env, .secrets/config.manifest.json, and .secrets/manifest.json, then:
chmod 600 .secrets/deploy.env .secrets/files/* 2>/dev/null || true
bash scripts/orchestrate-deploy.sh
```

- `TRAFFIC_GCP_PROJECT_ID` default is now seeded as `homepage-496107` from `config.manifest.json`.
- **Scripts**: [`scripts/orchestrate-deploy.sh`](scripts/orchestrate-deploy.sh) → [`scripts/seed_local_configs.py`](scripts/seed_local_configs.py) + [`scripts/push_local_secrets_to_sm.py`](scripts/push_local_secrets_to_sm.py) → [`scripts/integrate-and-deploy.sh`](scripts/integrate-and-deploy.sh).
- **Override directory**: `SECRETS_DIR=/path/to/.secrets bash scripts/orchestrate-deploy.sh`
- **IAM** (caller identity): `secretsmanager:CreateSecret`, `DescribeSecret`, `PutSecretValue` on manifest secret IDs, plus permissions required for `sam deploy` / CloudFormation.

### AWS setup

- **Infrastructure**: `aws/template.yaml`
- **Ingress Lambda**: `aws/src/contact-ingress.js`
- **Sender Lambda**: `aws/src/contact-sender.js`
- **Failure report Lambda**: `aws/src/contact-report.js`
- **Admin Lambda**: `aws/src/contact-admin.js`
- **Frontend route**: `/api/contact` (default when `gvp:contact-api-url` meta is empty), or set that meta / `window.__CONTACT_API_URL__` from [`scripts/sync-site-api-urls.mjs`](scripts/sync-site-api-urls.mjs) after deploy

### Required environment variables

Set these for the AWS stack / Lambda environment:

- `RESEND_API_KEY`
- `CONTACT_TO_EMAIL` (recipient inbox)
- `CONTACT_FROM_EMAIL` (must be a verified sender/domain in Resend)
- `CONTACT_REPORT_EMAIL` (optional; defaults to `CONTACT_TO_EMAIL`)
- `ADMIN_API_KEY` (required for `/admin` dashboard access)

For local setup, copy `.env.example` to `.env` and provide the same values when deploying the SAM stack.

### Resend sender verification

Resend requires that the `from` address is verified (domain or sender). Use a sender like:

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
- API routes:
  - `GET /api/contact/admin/summary`
  - `GET /api/contact/admin/messages`
  - `GET /api/contact/admin/messages/{id}`
  - `GET /api/contact/admin/health`
  - `POST /api/contact/admin/retry/{id}`
  - `POST /api/contact/admin/messages/{id}/suppress-report` (sets `reportSuppressed` on the DynamoDB item so the scheduled failure report email skips it)
- Auth: send `x-admin-key` matching `ADMIN_API_KEY`
- Website traffic embed:
  - Set `<meta name="gvp:traffic-report-embed-url" content="...">` in `admin/index.html` to a Looker Studio **Share → Embed report** URL (or pass `TRAFFIC_REPORT_EMBED_URL` when running the sync script / GitHub Action with **sync_api_urls**).
  - Recommended flow: GA4 property → Looker Studio (BigQuery data source) → **Share → Embed report** → store URL only in secrets / meta, not in git history.
  - If left empty, the admin page shows a placeholder instead of rendering the iframe.

### GA4 + BigQuery traffic analytics

The admin dashboard now supports native traffic widgets (sessions, geography, exit pages, session timelines, and bot/human estimates) through BigQuery-backed API routes.

#### 1) Link GA4 to BigQuery

- In GA4 Admin, create a BigQuery link to your GCP project.
- Ensure export is enabled for daily and intraday events.
- Verify tables are arriving in dataset: `events_YYYYMMDD`.
- BigQuery contains data only from when the link is enabled forward. It does not backfill full historical GA4 raw events unless you run a separate backfill/transfer process.

#### 2) Configure AWS stack for traffic API

Set these additional SAM parameters when deploying `aws/template.yaml`:

- `TrafficGcpProjectId`: GCP project ID that owns BigQuery dataset
- `TrafficBigQueryDataset`: Dataset name containing GA4 `events_*` tables
- `TrafficServiceAccountSecretArn`: Secrets Manager ARN with service account JSON
- `TrafficGa4PropertyId` (optional but recommended): GA4 numeric property ID for live Data API fallback

Required secret payload keys:

- `client_email`
- `private_key`

The same `ADMIN_API_KEY` protects contact and traffic admin APIs.

Runtime behavior:

- `summary`, `geo`, and `exit-pages` are **GA4 Data API first** for fresher data.
- `summary` adds complementary BigQuery bot/human estimates when BigQuery export is fresh (latest `events_YYYYMMDD` within 1 day).
- Session-level endpoints (`sessions`, `sessions/{sessionKey}`) remain BigQuery-backed because GA4 Data API does not provide equivalent event timeline detail.
- Response payloads include `data_source` and may include `complementary_source` / freshness metadata.

#### 3) Configure admin frontend endpoints

In `admin/index.html`, inline scripts read from metas:

- `gvp:contact-api-url` → sets contact, admin, and traffic API bases (`…/api/contact`, `…/admin`, `…/admin/traffic`)
- `gvp:traffic-report-embed-url` → Looker iframe URL (optional)

#### 4) Event taxonomy captured client-side

GA4 now receives structured events for session analysis:

- `page_view` (virtual routes: home/playground/portfolio)
- `section_navigation` (origin and destination sections)
- `theme_change` (space/garden)
- `project_interaction` (`open_details`, `open_link`, `open_dialog`, `close_dialog`)
- existing outbound click events via `data-track`

Create matching GA4 custom dimensions for params like `section`, `origin_section`, `interaction_type`, `project_id`, and `theme` if you want richer reporting in GA4 UI.

The admin page is intentionally separate from the public site shell. It is not linked publicly and should be accessed directly only by operators.

Scheduled failure reports (`aws/src/contact-report.js`) only include non-sent messages with `attempts > 0` and **exclude** items where `reportSuppressed` is true.
