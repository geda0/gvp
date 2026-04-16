# gvp

## Contact form (Amplify + AWS durable pipeline)

This repo is a static site hosted on Amplify, with an AWS-native durable contact pipeline used to receive and deliver contact messages.

### What “success” means

- The UI shows success only after the backend has **persisted** the message and queued it for delivery.
- Delivery happens asynchronously through SQS + Lambda, so accepted messages are durable even if Resend is temporarily unavailable.
- Failures are retained, retried, and surfaced through DLQ alarms and report emails.

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
- Auth: send `x-admin-key` matching `ADMIN_API_KEY`

The admin page is intentionally separate from the public site shell. It is not linked publicly and should be accessed directly only by operators.
