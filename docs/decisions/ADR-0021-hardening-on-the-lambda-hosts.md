# ADR-0021 — M8 hardening, re-scoped to the Lambda hosts that actually ship

- Status: Accepted (items 1, 2, 3, 5). Items 6–7 (read-only admin key, admin attention strip)
  are deferred until M4 releases `aws/src/contact-admin.js` and `js/admin.js`.
- Date: 2026-10-23
- Assigned by: ADR-0020's header ("M8 / ADR-0021"). The plan's own M-numbering of ADRs drifted
  from M7 on (ADR-0020 §6); this number was always M8's.
- Extends: ADR-0020 (bounded public sinks; its §"What this ADR does NOT cover" rulings on the
  rate guard and retention), ADR-0022 §15.3 / §18.E2–E5 / §23.2–23.3 (cost controls owed to the
  Lambda stream host), ADR-0025 (credential residency).
- Seam owner: architect

## Context — the plan's M8 text describes a host that no longer exists

`docs/plan-2026-09-port.md` M8 was written when chat ran on ECS Express. Since 2026-10-13
(ADR-0022 §35) every chat host is Lambda:

- `/api/chat` and `/api/chat/` → CloudFront → OAC → **RESPONSE_STREAM Function URL**
  (`aws/chat-stream-cdn-template.yaml`). There is **no API Gateway throttle** on this path. The
  only bound is the function's reserved concurrency (default 5, `aws/chat-stream-template.yaml`).
- Every other path, including the paid `/api/live/session`, uses CloudFront's default behavior →
  the chat HttpApi (`aws/chat-template.yaml`), with one stage-level throttle of 5 rps / burst 10.

Verified against the repo on 2026-10-23, item by item:

| Plan item | What the plan says | What is true |
|---|---|---|
| 1 H3/S1 | Gemini key via SSM SecureString on the ECS task, `CHAT_GEMINI_KEY_VIA_SSM` | **Refuted, already done another way.** ADR-0025 put the key in Secrets Manager, resolved at startup and scoped to one ARN. No deployed chat function carries it in plain env (peer session, measured 2026-10-23). The ECS task no longer exists. |
| 2 H2/S3 | In-process sliding-window global caps in `app/rate_guard.py`, "the FIRST rate limit … host is ECS Express" | **Premise gone, and the mechanism is unsound here.** An in-process counter on Lambda is per container (up to 5 stream containers plus the HttpApi ones), so it is not a global cap. ADR-0022 §15.3 already ruled what the Lambda host needs. None of it is built. |
| 3 H1/S4 | `ttl` refreshed on every write, 180 d after the last turn, `0` disables | **Correct, not built.** `ChatTranscriptsTable` has no `TimeToLiveSpecification`. Transcripts are kept forever today. |
| 4 H4/S2 | CSP + headers via `customHttp.yml` | **Done** earlier on 2026-10-23 (`test/security-headers.test.mjs`). |
| 5 H5/S5 | Privacy note: "hashed-IP analytics", "180-day retention" | **Would be false as written.** Google Analytics loads unconditionally and sees full IPs. Only the first-party `/api/events` beacon hashes IPs. Chat retention is unbounded until item 3 ships. The ADR-0008 consent gate was reversed on 2026-06-17. |

## Decision

### D1 — Item 1 is closed as refuted, not implemented

Nothing is built. Its real follow-ups are ADR-0025's filed-forward items (#1: retire the
disclosed staging key; #5: the retired Express template still holds a plaintext key), and they
stay there.

### D2 — Item 2 becomes ADR-0022 §15.3, built with one stated deviation

| Control | Where | Stage | Prod |
|---|---|---|---|
| Alarm: stream function `Invocations` Sum ≥ 2,000 / 5 min | `chat-stream-template.yaml` → `ChatStreamAlertTopic` | yes | yes |
| Alarm: `Invocations` Sum ≥ 20,000 / 1 h | same | yes | yes |
| Alarm: `Duration` Sum ≥ 1,800,000 ms / 1 h | same | yes | yes |
| AWS Budget, Lambda-scoped, $15/mo, ACTUAL 80% + 100% | `chat-stream-template.yaml`, **prod stack only** (a budget is account-wide; one copy) | — | yes |
| AWS Budget, account, $70/mo, ACTUAL 80% + 100% | same | — | yes |
| WAF rate-based rule, 300 requests / 5 min / IP, on the distribution | new `aws/chat-waf-template.yaml` (us-east-1, `Scope: CLOUDFRONT`) → `WebAclArn` parameter on the CDN stack | optional | **yes** |

- **Deviation from §15.3, deliberate:** §15.3 marks both budgets "required" for stage *and*
  prod. A budget is account-wide, so two stacks would mint two copies and email twice. They
  are created by the **prod** stream stack only.
  - Consequence: if only the stage stream stack is deployed, no budget exists.
  - The budgets and the three alarms are also skipped when the stack has no alarm email
    (`HasChatAlertAlarm`). The deploy script now prints a `::warning::` when a prod deploy
    has none.
  - The budget names are fixed (`gvp-lambda-monthly`, `gvp-account-monthly`). If a budget with
    either name was created by hand, the first prod deploy fails. Check
    `aws budgets describe-budgets` first.
- The deploy script refuses to deploy the CDN stack if the WAF stack yields no
  `arn:aws:wafv2:` ARN, rather than failing later inside it.
- **No in-process `rate_guard.py`.** It would add a per-container illusion of a cap. The real
  ceilings are WAF (per IP, at the edge) and reserved concurrency (global, at the function).
  ADR-0020's "per-IP limits default 0 = OFF" concern (shared NAT) is answered by the WAF limit's
  size: 300 / 5 min / IP is far above any one household's real use and far below a scripted
  loop's.
- **Cost, stated, not hidden:** WAF is about $5/month per web ACL plus $1 per rule plus
  $0.60 per million requests, so roughly $6/month for prod.
- **Owed and NOT doable from a repo:**
  - E4: the kill-switch rehearsal on stage (`put-function-concurrency … 0`, confirm 429,
    restore).
  - E2: validating each alarm once (`set-alarm-state`).
  - E5: the from-data cost computation.

  These are AWS writes for whoever holds credentials, and are recorded here so they are not
  "done" by default.
- **Deployability:** these resources live in the chat stream and CDN stacks. They inherit the
  two CI blockers recorded in ADR-0020 §6.4 (the ECR Public throttle, then the stale
  `gvp-<env>-chat-deploy` IAM policy), plus `wafv2:*` on the us-east-1 web ACL, which the IAM
  draft must grow.

### D3 — Item 3, transcript retention

**This reverses an owner decision, deliberately and reversibly.** Commit `4557056`
(2026-05-18, "stay forever") removed transcript expiry. The later plan (2026-09) and the
product-owner backlog (`.claude/state/backlog.md` ~686) re-specify 180 days, so the later
decision governs. It is safe to undo:
- only *new* writes carry `ttl`, and nothing is backfilled, so no existing transcript is
  deleted;
- the first possible expiry is 180 days after deploy;
- `CHAT_TRANSCRIPT_TTL_DAYS=0` restores "stay forever" with an env/template change, not a
  code change. The stream template does not set the variable today.

- Every successful transcript write sets `ttl` = server-clock epoch seconds + N days, where N is
  `CHAT_TRANSCRIPT_TTL_DAYS` (default **180**, `0` = do not write `ttl`). The clock is the
  server's, never the caller's (ADR-0020 A1).
- `ChatTranscriptsTable` gets `TimeToLiveSpecification { AttributeName: ttl, Enabled: true }`.
- **`TTL` is a DynamoDB reserved word.** The write uses `#ttl` through
  `ExpressionAttributeNames`. A bare `ttl = :ttl` would fail every transcript write at runtime,
  and the unit tests' fake table cannot raise that error. Caught before merge, `ed94515`.
- DynamoDB deletes expired items lazily (typically within days), and point-in-time recovery
  keeps deleted items restorable for 35 days.
- Stated consequences:
  - A write refused by the byte budget does not refresh `ttl`, so a full session expires 180 days
    after its last *accepted* turn.
  - Admin note/review updates do not extend retention.
  - Existing items written before this change have no `ttl` and are **not** backfilled by this
    ADR. A one-off backfill is an operator action, like `backfill-listpk.js`.

### D4 — Item 5, the privacy note says only what is true

A "Privacy" link in the **site** `<footer>` (the one holding `#footerOpenContactBtn`, not the
chat dialog's) opens a plain-words dialog that reuses the contact dialog shell. It says exactly
this, as verified against the code; the critic corrected two first-draft claims:

- Chat and voice content is sent to **Google Gemini** to produce replies.
- Conversation text is kept. **New** conversations are deleted about 180 days after their
  last message; **older ones, from before the rule, are still kept** (no backfill, D3).
- **No audio is stored, but a voice conversation's words are kept as text.**
  `/api/live/transcript` persists `userText` and `assistantText`. The first draft wrongly said
  "only byte counts".
- The microphone is used only while voice is on.
- Site events are kept 120 days, with the IP HMAC-hashed.
- **Google Analytics also runs and sees the IP.**
- Contact-form messages are kept so they can be answered.

The two numbers are derived from the constants that enforce them. The copy's required
statements, and a stub-DOM behaviour test (text-only rendering, focus in and back, Escape,
backdrop), are in `test/privacy-note.test.mjs`.

**Promotion rule.** The note ships with the static site, but the TTL ships with the chat image
and the contact stack. **Do not promote this to `main` before the `#ttl` writer and the table
TTL are deployed to prod**, or prod will display a retention promise that nothing enforces.

## Measured on stage, 2026-10-23 (peer session, direct deploy of `agent@42d463a`)

- **Deploy:** the stream function was redeployed, with CodeSha256 `9b577fa6…` → `a28da3d0…` at
  16:58Z. All eight stage chat alarms exist and are OK:
  - the three §15.3 alarms (`invocations-5m`, `invocations-1h`, `duration-1h`);
  - P1/P2 alert-line alarms on both hosts;
  - the older Lambda-errors alarm.
- **E4, kill switch: PASS, fully reversed.** Reserved concurrency was 5, recorded first.
  1. Baseline turn: **200** (15.7 s, cold).
  2. Set to 0: the next turn got **429 in 299 ms** —
     `ReservedFunctionConcurrentInvocationLimitExceeded`. It fails at the edge *without
     invoking the function*, so an engaged kill switch costs nothing.
  3. Restored to 5: the next turn got **200** (2.9 s). Net change: none.
- **D3, both halves are true on stage:**
  - `page-staging-ChatTranscriptsTable` TTL is ENABLED on `ttl`.
  - A fresh session (`e4-restored-ttl-witness`) carries `ttl = 1808327559` (2027-04-21),
    exactly +180.0 days.
  - **Prod is still DISABLED and still unwritten.** D4's promotion rule stands.
- **E2, alarm validation with `set-alarm-state`: not run.** Both sessions' permission
  classifiers refuse it, so it is with the account owner as a one-liner. **E3, budgets:**
  prod only, so not yet created. **E5, from-data cost:** not yet computed.

## Consequences

- M8 item 2 shrinks from "build a limiter" to "build the controls an earlier ADR already
  required". That is less code and more infrastructure, and most of it waits on the same CI
  unblock as M7's chat-side alarms.
- Until the WAF rule is live, prod's stream path runs in breach of ADR-0022's own M-4 GO list.
  That is recorded here, not fixed by assertion.
