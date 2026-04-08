# gvp

## Contact form (Netlify + Resend)

This repo is a static site, plus Netlify Functions used to receive contact messages and deliver them via email.

### What “success” means

- The UI shows success only after the server has **persisted** the message (Netlify Blobs).
- Email delivery is attempted immediately. If it fails, delivery is retried by a scheduled function until it succeeds.

### Netlify setup

- **Functions** live in `netlify/functions/`
- **API route**: `/api/contact` (redirected to `/.netlify/functions/contact` via `netlify.toml`)
- **Retries**: `netlify/functions/retry-contact.js` runs every 5 minutes.

### Required environment variables

Set these in Netlify (Site settings → Environment variables):

- `RESEND_API_KEY`
- `CONTACT_TO_EMAIL` (recipient inbox)
- `CONTACT_FROM_EMAIL` (must be a verified sender/domain in Resend)

For local setup, copy `.env.example` to `.env` (or use your Netlify CLI env workflow) and replace the dummy values.

### Resend sender verification

Resend requires that the `from` address is verified (domain or sender). Use a sender like:

- `CONTACT_FROM_EMAIL=Marwan <no-reply@yourdomain.com>`

### Storage and delivery reporting

- Messages are stored in Netlify Blobs until delivery succeeds.
- If messages remain pending (3+ attempts), the retry job sends a daily report to `CONTACT_TO_EMAIL`.
