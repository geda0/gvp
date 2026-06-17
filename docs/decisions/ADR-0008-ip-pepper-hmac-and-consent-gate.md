# ADR-0008 — Keyed (HMAC) ipHash with a deploy-injected pepper, and a consent gate before analytics

## Status

**SEC-2 (HMAC ipHash): Accepted + shipped (staging + prod).** **SEC-1 (consent gate): REVERSED 2026-06-17**
— the owner decided the site does not need an analytics-consent gate (personal portfolio, sole data
controller, low blast radius; the pre-prod review rated consent acceptable-to-skip). The consent banner +
the GA/beacon consent gating + `js/consent.js` were removed; analytics + the first-party beacon fire
unconditionally as before. The SEC-1 sections below are retained for history only and no longer reflect the code.

Addresses pre-prod review findings **SEC-2** (unsalted SHA-256 IP hash) and **SEC-1**
(no consent gate before GA + first-party beacon). Both touch privacy seams that the new
first-party events store widened, so they are decided together.

This ADR **is the deliberate security review** for the SECURITY_GLOB surfaces it changes
(`aws/src/common/contact-shared.js`, `aws/src/common/events-shared.js`, `aws/template.yaml`). The
implementer is cleared to edit those files under `SECURITY_REVIEW=1` to the contracts below — and
to **nothing beyond** them.

## Context

`hashIp()` in `aws/src/common/contact-shared.js:27-31` is a plain `SHA-256(ip)` truncated to 16 hex
chars with no salt/pepper. The IPv4 space (~4.3B values) is trivially rainbow-tableable, so `ipHash`
is effectively reversible to the source IP. This was tolerable on the low-volume contact table, but
the new beacon (`aws/src/common/events-shared.js:58-59`) reuses the same primitive as the
per-visitor identity (`uniqueVisitors` keys on `ipHash` in `common/daily-report.js`) on a **public,
unauthenticated, higher-volume** endpoint (`POST /api/events`, up to 100 rows/request, 120-day TTL).
A read of `SiteEventsTable` (or a backup/export) would de-anonymize every visitor IP.

Separately, the FE fires **both** Google Analytics and the owned beacon with no consent prompt
(`js/analytics.js:10-29`, `js/site-events.js:83-94`, wired in `js/app.js`). The data includes
IP-derived `ipHash`, `sessionId`, page/section, and user-agent — personal data under GDPR/ePrivacy
with no legal basis for EU/UK visitors.

Existing secret-injection pattern (the seam we should reuse): `RESEND_API_KEY` / `ADMIN_API_KEY`
arrive as `deploy.env` / GitHub secrets → `integrate-and-deploy.sh` `sam_param_override` →
`AWS::Serverless` `Parameter` with `NoEcho: true` → Lambda env var via `Globals.Function.Environment`
(`aws/template.yaml:18-20,40-49`, `scripts/integrate-and-deploy.sh:149-155`). No Lambda makes a
runtime `secretsmanager:GetSecretValue` call today.

## Decision

### 1. Keyed ipHash (SEC-2): HMAC-SHA256 with a deploy-injected pepper

**Primitive.** `hashIp(ip)` becomes `HMAC-SHA256(pepper, ip)` truncated to 16 hex chars. A keyed
hash defeats precomputed rainbow tables: without the pepper an attacker cannot reverse `ipHash`.

**Where the pepper lives & how it is injected — reuse the `AdminApiKey` seam, do NOT add a runtime
Secrets Manager fetch.** Add a `NoEcho` SAM parameter `IpHashPepper` and inject it as an env var
`IP_HASH_PEPPER` for the functions that hash IPs (contact ingress, events ingress). The value is
sourced from `.secrets/deploy.env` (`IP_HASH_PEPPER=`) and a GitHub repo secret of the same name,
plumbed through `integrate-and-deploy.sh`'s `PO` array exactly like `AdminApiKey`.

**Why env-injection over a runtime `GetSecretValue`.** A runtime fetch would mean (a) new IAM
(`secretsmanager:GetSecretValue` scoped to one secret ARN), (b) a cold-start network call on the hot
ingress path, and (c) a second secret-distribution mechanism alongside the one that already works.
The pepper is a low-rotation, deploy-time value — the SAM-parameter-as-env seam is the proportionate
choice and adds **zero new IAM**. (If the project later moves *all* secrets to Secrets-Manager-backed
SAM dynamic references — `{{resolve:secretsmanager:...}}` — the pepper rides that migration with no
ADR change; that is a CloudFormation-resolution feature, still not a Lambda runtime fetch / new IAM.)

**Least privilege.** Because the pepper is a deploy-time parameter, the contract is: **the
events/contact Lambdas gain no new IAM action.** Should a future variant use a runtime fetch instead,
the IAM MUST be `secretsmanager:GetSecretValue` on that single secret's ARN only — never `*`.

**Backward-compat (the seam break).** Changing the key changes every hash. Old `ipHash` values stop
matching new ones, so `uniqueVisitors`/`sessions` counts straddling the cutover are not comparable.
**This is acceptable** — `ipHash` is fire-and-forget analytics with a 120-day raw TTL and the daily
email as the durable record; there is no migration to perform and no cross-table join on `ipHash`.
The implementer MUST NOT attempt to re-hash historical rows.

- **Contract:** `hashIp(ip, pepper)` (the pepper is an explicit argument so the pure helper stays
  unit-testable without env). The two ingress core modules read `IP_HASH_PEPPER` from their injected
  `env` and pass it in. Empty pepper → the implementer decides fail-closed vs degrade-to-unkeyed at
  the green step, but the FAILING TEST is the spec; this ADR only fixes the signature and the keyed
  algorithm. Output stays a 16-hex-char string so downstream `Set`-based dedup is unchanged.

### 2. Consent gate (SEC-1): a single chokepoint before any analytics fires

**Seam:** a `hasAnalyticsConsent()` predicate (FE, e.g. `js/consent.js`) read from `localStorage`.
**Contract (behavioral, UI-agnostic):**

- Until consent is granted, `initAnalytics()` MUST NOT call `gtag('config', …)` and `recordEvent()`
  / `flushEvents()` MUST NOT emit a beacon (buffering is fine; flushing is not).
- On consent granted, GA config + a flush of any buffered beacon events may proceed.
- The page MUST remain fully functional with consent denied (analytics is best-effort).

This ADR deliberately does **not** dictate the banner UI, default-deny-by-region logic, or storage
key name — only that both sinks (`js/analytics.js` and `js/site-events.js`) honor one shared
predicate so a single switch governs all collection. The implementer chooses the UI at the green
step.

## Consequences

- **New SAM parameter + env var** (`IpHashPepper` / `IP_HASH_PEPPER`) and one new line in
  `deploy.env.example` + the GH-secrets list. `aws/template.yaml` and `integrate-and-deploy.sh`
  change; **no new IAM**. The pepper MUST be set before deploy or the ingress functions hash with an
  empty key (the test pins the chosen behavior).
- **One-time analytics discontinuity** at the pepper cutover — accepted, documented above.
- **One FE chokepoint** (`hasAnalyticsConsent`) that both GA and the beacon consult; future sinks
  must route through it.
- Does not address SEC-3 (per-IP abuse), SEC-4/INFRA-5 (pre-parse body cap) — see ADR-0009.
- **Does not supersede** ADR-0004 (contact durability) or ADR-0006 (handler testability seam); the
  injectable-core seam is the reason `hashIp(ip, pepper)` stays a pure, testable helper.

## Implementer clearance (SECURITY_GLOB)

Cleared under `SECURITY_REVIEW=1` for: `aws/src/common/contact-shared.js` (hashIp signature +
algorithm), `aws/src/common/events-shared.js` (pass pepper through), `aws/template.yaml` (add
`IpHashPepper` NoEcho param + `IP_HASH_PEPPER` env on the two ingress functions). Out of scope for
this ADR: any other behavior on those surfaces.
