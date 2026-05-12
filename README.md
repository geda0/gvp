# gvp

## Contact form (Amplify + AWS durable pipeline)

This repo is a static site hosted on Amplify, with an AWS-native durable contact pipeline used to receive and deliver contact messages.

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
   - Either `TRAFFIC_SERVICE_ACCOUNT_SECRET_ARN` **or** `GCP_SERVICE_ACCOUNT_JSON` (full service-account JSON; the script upserts Secrets Manager and passes the ARN automatically).

4. **Workflow inputs**
   - **sync_api_urls**: if enabled, patches `index.html` and `admin/index.html` in the runner and uploads them as artifact **`site-html-api-urls`** (commit or copy into Amplify manually).

Local equivalent (after `aws login` / `AWS_PROFILE`):

```bash
export RESEND_API_KEY=... CONTACT_TO_EMAIL=... CONTACT_FROM_EMAIL=... ALARM_EMAIL=... ADMIN_API_KEY=...
# optional traffic + auto secret:
export TRAFFIC_GCP_PROJECT_ID=... TRAFFIC_BIGQUERY_DATASET=... GCP_SERVICE_ACCOUNT_JSON="$(cat sa.json)"
# optional: patch HTML after deploy
export SYNC_API_URLS=1
bash scripts/integrate-and-deploy.sh
```

### AWS setup

- **Infrastructure**: `aws/template.yaml`
- **Ingress Lambda**: `aws/src/contact-ingress.js`
- **Sender Lambda**: `aws/src/contact-sender.js`
- **Failure report Lambda**: `aws/src/contact-report.js`
- **Admin Lambda**: `aws/src/contact-admin.js`
- **Frontend route**: `/api/contact` (or override with `window.__CONTACT_API_URL__`)

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
  - Configure `window.__TRAFFIC_REPORT_EMBED_URL__` in `admin/index.html` with a full report embed URL.
  - Recommended flow: GA4 property -> Looker Studio data source -> dashboard with widgets -> **Share > Embed report** -> paste URL into `__TRAFFIC_REPORT_EMBED_URL__`.
  - If left empty, the admin page shows a placeholder message instead of rendering an iframe.

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

Required secret payload keys:

- `client_email`
- `private_key`

The same `ADMIN_API_KEY` protects contact and traffic admin APIs.

#### 3) Configure admin frontend endpoints

In `admin/index.html`:

- `window.__TRAFFIC_API_BASE_URL__` should point to `/api/contact/admin/traffic`
- `window.__TRAFFIC_REPORT_EMBED_URL__` can be set to your Looker Studio embed URL for full visual reports

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
