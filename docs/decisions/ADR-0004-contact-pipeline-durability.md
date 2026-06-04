# ADR-0004 — Contact-pipeline durability: persist + enqueue before success

## Status

Accepted. (Retroactively recorded during the teamentic adoption bootstrap.)

## Context

The contact form must not lose a legitimate message just because the email provider
(Resend) is momentarily down, and it must not let bot spam reach the inbox or the data
store. Email delivery is inherently flaky, so delivery cannot be on the request's
critical path. See `docs/architecture.md` §3.

## Decision

A submission is **successful** only once it is durably stored **and** enqueued for
delivery; delivery itself is asynchronous with bounded retries and operator visibility.

- **Persist then enqueue, then 200:** `contact-ingress` writes to DynamoDB with
  `PutItem` (`ConditionExpression: attribute_not_exists(id)` for idempotency), then sends
  to SQS, then returns `200 { persisted, queued }`
  (`aws/src/contact-ingress.js:44-68`). Any failure in that block returns 500 so the UI
  does not show false success (`contact-ingress.js:69-77`).
- **Honeypot silent-discard:** the hidden `company` field — `<input name="company"
  tabindex="-1">` (`index.html:257`), sent by the FE (`js/contact.js:95`) — short-circuits
  in ingress: if `record.company` is truthy, return `200 { ok }` with **no** PutItem and
  **no** enqueue (`contact-ingress.js:31-33`). Bots get a fake success and nothing is
  stored or delivered.
- **Async delivery:** `contact-sender` drains SQS, marks `sending`, calls Resend, then
  `sent` or `failed`, and re-throws on failure so SQS redelivers
  (`aws/src/contact-sender.js:68-95`).
- **Bounded retry + alarm + report (`aws/template.yaml`):** `ContactDeliveryQueue`
  redrives to `ContactDeliveryDlq` after `maxReceiveCount: 5`
  (`template.yaml:143-148`); `ContactDlqAlarm` fires on DLQ
  `ApproximateNumberOfMessagesVisible > 0` → SNS email topic
  (`template.yaml:157-172`); `ContactFailureReportFunction` runs a daily cron
  `cron(0 12 * * ? *)` to email a failure summary (`template.yaml:213-225`).

## Consequences

- A message is durable the instant PutItem + enqueue succeed; it survives Resend
  outages and is retried up to 5× before landing in the DLQ. This is the load-bearing
  guarantee behind the "what success means" promise (README:53-57).
- The honeypot is a behavioral contract: bot submissions must stay invisible (200, no
  persistence). Changing `company` handling changes what the admin list and reports see.
- Operator surfaces (DLQ alarm email + daily report) are part of the contract —
  removing them silently hides delivery failures. The report intentionally excludes
  `reportSuppressed` rows (README:117).
- Code matches the architecture doc's §3 sequence diagram; no discrepancy found.
