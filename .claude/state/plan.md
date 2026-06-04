# Plan: contact durability (invariants #3/#4/#5 via the ADR-0006 injectable-core seam)

> Written by the `planner` subagent at the start of each feature; consumed by the
> orchestrator one slice per cycle. Tick a box when its slice reaches green.
> This file is part of the continuity contract — it tells the next agent exactly
> which slice is next.
>
> Tests import `createIngressHandler` from `aws/src/contact-ingress-core.js` and
> `createSenderHandler` from `aws/src/contact-sender-core.js`, injecting fakes — NO
> `@aws-sdk`. Test file(s) under `test/` (app TEST_GLOB), `node --test`. Order is the
> execution order: ingress seam first (S1–S6), then sender seam (S7–S10).

- [x] S1 [app] valid submission → `createIngressHandler` awaits `persistMessage` THEN `enqueueDelivery` (order recorded by the fakes), then resolves `200` whose body reports `persisted:true` + `delivery:'queued'` and the record id (brings `contact-ingress-core.js` into existence) (inv: #3)
- [x] S2 [app] `persistMessage` rejects → handler resolves `500` and `enqueueDelivery` is NEVER called (no false success, no orphan enqueue) (inv: #3)
- [x] S3 [app] `enqueueDelivery` rejects after a resolved `persistMessage` → handler resolves `500` (caller never sees a false `200`) (inv: #3)
- [x] S4 [app] honeypot: event body with `company` non-empty → `200` with `persistMessage` AND `enqueueDelivery` both NEVER called; same fakes assert `company` empty still calls both (honeypot blocks only on truthy `company`, never real traffic) (inv: #4)
- [x] S4a [app] harden honeypot body: the silent-200 carries the hollow decoy shape (`persisted:true`, `delivery:'queued'`, NO `id`) so the S5 refactor can't "tidy" the anti-spam decoy (inv: #4) [characterization — green on write] — tdd-critic Finding 2
- [x] S4b [app] malformed JSON body → `400` `{Invalid JSON}`; no persist/enqueue (core currently lets `parseJsonBody` throw → would 500; live divergence) (inv: #3)
- [x] S4c [app] payload failing `validateMessage` → `400`; no persist/enqueue (core currently SKIPS validation → would persist an invalid payload; live divergence) (inv: #3)
- [x] S4d [app] missing config (`env` lacks `CONTACT_MESSAGES_TABLE`/`CONTACT_DELIVERY_QUEUE_URL`) → `500`; no persist/enqueue (core currently ignores `env`) (inv: #3)
- [x] S4e [app] method gate: `OPTIONS` → `optionsResponse` preflight; non-`POST` (e.g. `GET`) → `405`; no persist/enqueue (inv: #3)
> S4b–S4e make `contact-ingress-core.js` a FAITHFUL FULL replacement of the handler (every
> branch pinned by node:test) so S5's composition root is truly thin and the extraction is
> behavior-preserving — the tdd-critic's S5-readiness gate.
- [x] S5a [app] guard: `contact-ingress-core.js` imports NO `@aws-sdk/*` (protects the install-free node floor BEFORE the root legitimately imports the SDK at S5) (inv: ADR-0005/0006) [first red of S5] — tdd-critic Finding 5
- [x] S5 [app] refactor: rewrite `aws/src/contact-ingress.js` into the thin composition root wiring the REAL DynamoDB `PutCommand` (keeping `attribute_not_exists(id)`) + SQS `SendMessageCommand` into `createIngressHandler`, `export const handler` and deployed behavior identical, suite stays green (inv: #3)
- [x] S6 [app] sender success → `createSenderHandler` awaits `sendEmail` THEN `store.markSent(id, attempts, info.id)`; `store.markFailed` NEVER called (brings `contact-sender-core.js` into existence) (inv: #5)
- [x] S7 [app] sender: `store.loadMessage` returns a row with `status==='sent'` → no-op: `sendEmail` NEVER called and no `store.mark*` write (safe redelivery, no duplicate email) (inv: #5)
- [x] S8 [app] sender: `sendEmail` rejects → `store.markFailed(id, attempts, errorMessage)` is called AND the handler promise rejects/re-throws (so SQS redelivers) (inv: #5)
- [x] S9 [app] refactor: rewrite `aws/src/contact-sender.js` into the composition root wiring the real DDB `store` (load/markSending/markSent/markFailed) + `sendViaResend` as `sendEmail`, `export const handler` and deployed behavior identical, suite stays green (inv: #5)

## Notes (NOT slices — out of scope for node:test, asserted by review)
- The `attribute_not_exists(id)` idempotency guard lives in the composition root's real
  `PutCommand` (S5), not the core — asserted by review against ADR-0004/0006, not node:test.
- The SQS redrive (`maxReceiveCount:5`) → DLQ → `ContactDlqAlarm` → SNS half of #5 is infra
  (`aws/template.yaml`), asserted by review against ADR-0004 — not a node unit test.
- Constraint to keep green (watch in tdd-critic): `contact-ingress-core.js` and
  `contact-sender-core.js` must NEVER import `@aws-sdk/*`. An optional one-line guard test
  scanning the two core files for an `@aws-sdk` import is cheap reinforcement, not required.
