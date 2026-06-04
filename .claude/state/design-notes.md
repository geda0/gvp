# Design notes (durable intent across cycles)

> Orchestrator maintains this. Subagents start fresh; anything that must survive
> between cycles lives here.

## Feature goal
> ✅ **SHIPPED + accepted 2026-06-03** (tdd-critic PASS; product-owner sign-off; 23/23 green;
> invariants #3/#4/#5 proven). Kept below as the durable record of this feature. The next
> feature (chat coverage gaps, `[chat]` layer) will repopulate this file via planner/PO.

**Characterize contact-pipeline durability** (invariants #3/#4/#5 — "no dropped
submissions") with `node --test`, via the ADR-0006 injectable-core seam. Today the
contact Lambda JS has ZERO node tests; this feature proves the durability behavior
that the product relies on, without changing what the deployed Lambdas do.

Backlog items 2, 3, 4 (app layer). See `.claude/state/backlog.md` for full acceptance.

## The seam (ADR-0006 — Approach B, injectable core)
Extract logic into NEW pure modules that import **no `@aws-sdk`**; the existing
handlers become thin composition roots that build the real clients and wire them,
keeping `export const handler` + deployed behavior identical.

```
aws/src/contact-ingress-core.js
  export function createIngressHandler({ persistMessage, enqueueDelivery, env = process.env })
    persistMessage(record): Promise<void>            // real impl keeps attribute_not_exists(id)
    enqueueDelivery({ id, idempotencyKey }): Promise<void>
aws/src/contact-sender-core.js
  export function createSenderHandler({ store, sendEmail, env = process.env })
    store: { loadMessage, markSending, markSent, markFailed }   // each -> Promise<void>
    sendEmail(args): Promise<{ id? }>                            // root binds sendViaResend
```
Each factory returns `async (event) => response` (same shape as today). Tests import the
`*-core.js` factories and inject fakes — the node test layer needs no `@aws-sdk` and no
CI install step.

## Acceptance checklist (observable; from items 2–4)
- [ ] (app) valid submission → `persistMessage` then `enqueueDelivery` both called, IN
      THAT ORDER, before a `200` whose body reports persisted + queued.
- [ ] (app) `persistMessage` throws → `500` (no false success; no enqueue).
- [ ] (app) `enqueueDelivery` throws after a successful persist → `500`.
- [ ] (app) honeypot: `company` non-empty → `200` with NO `persistMessage` / NO
      `enqueueDelivery` (and so no delivery email).
- [ ] (app) honeypot empty → normal persist+enqueue path (honeypot never blocks real traffic).
- [ ] (app) sender: row already `status==='sent'` → no-op (`sendEmail` NOT called; no dup).
- [ ] (app) sender: `sendEmail` fails → `markFailed` AND re-throw (so SQS redelivers).
- [ ] (app) sender: `sendEmail` succeeds → `markSent`.

## Decisions made
- 2026-06-03 — Approach B (injectable core) over mocking the SDK in place (ADR-0006),
  because it keeps the always-present `node --test` floor `@aws-sdk`-free / install-free
  (ADR-0005). No CI or package.json change.
- New constraint (watch in tdd-critic): `contact-*-core.js` must NEVER import `@aws-sdk/*`.
- Not unit-tested here (by design): the `attribute_not_exists(id)` idempotency guard and
  the SQS redrive→DLQ→CloudWatch-alarm half of #5 live in the composition root / infra —
  asserted by review against ADR-0004/0006, not a node unit test.

## Next 1–3 behaviors to specify
1. Ingress valid path: `persistMessage` then `enqueueDelivery`, then `200 {persisted, queued}`
   (establishes the `createIngressHandler` seam).
2. Ingress failure mapping: persist throws → 500; enqueue throws → 500.
3. Ingress honeypot: `company` set → 200 + no IO; `company` empty → normal path.
   (Sender slices 4–8 follow once the ingress seam is green.)

## Deferred smells / tech debt
- `contact-ingress.js` / `contact-sender.js` logic is inline today; extraction to the
  cores is part of THIS feature (green/refactor), keeping deploy behavior equivalent.
- Pure helpers `common/contact-shared.js` (buildMessageRecord/validateMessage) and
  `common/resend.js` are directly unit-testable — candidate follow-up coverage.
