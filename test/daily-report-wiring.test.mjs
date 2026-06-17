import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// contact-daily-report.js is a Lambda ENTRY file: it imports `@aws-sdk/*` at the
// top, which the SDK-free `node --test` baseline does not install (ADR-0005/0006 —
// see test/contact-core-no-aws-sdk.test.mjs). Importing the handler here would fail
// at module resolution (an import error, NOT a behavior assertion), so the cross-
// track wiring this entry file carries — the deep-probe request shape and the
// daily-email idempotency key — is asserted against the file TEXT, the same
// proven pattern test/template-hardening.test.mjs uses for the SDK-laden template.
//
// What this guard CANNOT do (must be verified by the implementer at green, or by an
// SDK-installed integration test): drive the real handler end-to-end (stub
// global.fetch, assert the captured chat-smoke request + the resend Idempotency-Key
// header on the wire). resend.js forwarding a supplied key is already proven by
// test/resend-idempotency.test.mjs; the gap closed HERE is that the handler actually
// THREADS a day-derived key into that sendViaResend call.
const reportPath = fileURLToPath(new URL('../aws/src/contact-daily-report.js', import.meta.url))
const report = readFileSync(reportPath, 'utf8')

test('daily report wires the probe-scoped smoke credential, the report cooldown bypass, and a day-derived email idempotency key (ADR-0009 S11/S17/S18)', () => {
  // --- S18 / FE-2: the deep chat probe must authenticate with the PROBE-SCOPED key
  // (x-smoke-key / SMOKE_PROBE_KEY), NOT the contact-admin key. The chat host's
  // /api/chat/smoke validates x-smoke-key against SMOKE_PROBE_KEY (docker/chat/app/
  // main.py _check_smoke_key) and rejects x-admin-key, so the current header wiring
  // (x-admin-key: ADMIN_API_KEY) authenticates against the WRONG credential. ---
  assert.match(
    report,
    /['"]x-smoke-key['"]\s*:\s*process\.env\.SMOKE_PROBE_KEY/,
    'expected the deep chat probe to send header x-smoke-key = process.env.SMOKE_PROBE_KEY (the probe-scoped credential, not x-admin-key/ADMIN_API_KEY)'
  )
  assert.doesNotMatch(
    report,
    /['"]x-admin-key['"]/,
    'the deep chat probe must NOT authenticate with the contact-admin key (x-admin-key) — a leaked admin key must not mint paid Live probes'
  )

  // --- S17 / SEC-7: the trusted once-daily report caller bypasses the server-side
  // deep-probe cooldown via ?report=1, so the daily digest is never starved by an
  // ad-hoc dashboard probe. The probe URL must carry report=1 alongside deep=1. ---
  assert.match(
    report,
    /deep=1&report=1/,
    'expected the deep chat probe URL fragment to be deep=1&report=1 (the SEC-7 cooldown bypass on the actual probe URL — a stray report=1 in a comment or a report=0 must NOT satisfy this)'
  )

  // --- S11 / EV-2: the daily email send must forward a stable Idempotency-Key
  // derived from the report DAY (e.g. `daily-report-<day>`) so a retry / double-fire
  // of the scheduled report collapses to ONE delivered email. ---
  assert.match(
    report,
    /idempotencyKey:\s*`daily-report-\$\{day\}`/,
    'expected sendViaResend to be called with idempotencyKey: `daily-report-${day}` so a report retry dedupes to one email'
  )
})
