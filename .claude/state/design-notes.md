# Design notes (durable intent across cycles)

> Orchestrator maintains this. Subagents start fresh; anything that must survive
> between cycles lives here.

## Feature in flight (outer loop — full-team)

**MILESTONE: Pre-prod hardening → stage.** 23 unique confirmed-real review findings turned into a
prioritized backlog (P0/P1/P2 in `backlog.md`). Target is **STAGE**, not prod. Owner directive:
"fix everything and do everything the right way, then re-deploy to stage." The orchestrator works the
P0 items first (build → red→green per item), then P1, then P2. Each item's acceptance bullets are in
`backlog.md`; this file holds the cross-cutting decisions and the navigator escalations.

### Acceptance gate for the whole milestone (what "done → deploy to stage" means)
- [ ] All **P0** items (1–4) accepted: Amplify env-guard, DailyReport alarm, consent gate, HMAC ipHash.
- [ ] All **P1** items (5–12) accepted.
- [ ] P2 items (13–23 + INFRA-3) addressed OR explicitly deferred-with-owner-signoff (they are
      fast-follow-eligible; owner's call whether to gate the stage deploy on them).
- [ ] Full `node --test` app suite GREEN; chat pytest GREEN (items 9, 10 touch chat).
- [ ] `tdd-critic` = PASS on the milestone.
- [ ] qa-verifier has confirmed the UX bullets: consent banner (item 3), admin-panel avgFirstToken
      labels (item 11), deep-probe still works after the key split (item 10).
- [ ] Deploy to **staging only** (`bash scripts/integrate-and-deploy.sh stage`); prod is NOT promoted
      in this milestone.

## Decisions (3 judgment calls — RECOMMEND; owner to confirm)

> The owner said "do everything the right way." For each call I took the proper-engineering option over
> the minimal-compromise one, but kept each proportionate to a personal-portfolio blast radius.

### Decision 1 — SEC-2 (visitor IP identifier): **HMAC-SHA256 + Secrets Manager pepper** ✅
- **Chosen:** keyed HMAC with a server-side pepper from Secrets Manager (not the "drop ipHash, use
  sessionId only" alternative).
- **Why:** (a) Preserves the `uniqueVisitors` metric, which sessionId CANNOT reliably back — sessionId
  is per-tab and, per **FE-3**, collapses to a shared `'no-session'` constant when storage is disabled;
  deriving uniqueness from it would be strictly worse and entangle two findings. (b) HMAC with a secret
  pepper defeats the rainbow-table reversibility that is the actual SEC-2 defect (the ~4.3B IPv4 space is
  trivially precomputable against an unkeyed SHA-256). (c) The stack already uses Secrets Manager, so the
  marginal infra cost is small — this is the "right way." (d) Optional later: rotate the pepper per epoch
  to limit cross-day correlation (not required for sign-off).
- **Navigator note (fail-safe behavior):** if no pepper is configured, the function must fail safe.
  Recommend it **refuses to start / errors loudly** rather than silently falling back to the unkeyed hash
  (a silent fallback would re-introduce the exact defect). Confirm this preference.

### Decision 2 — SEC-1 (consent gate UX): **minimal dismissible banner + `localStorage` flag** ✅
- **Chosen:** a one-time dismissible banner storing a consent flag in `localStorage`, gating BOTH the
  `gtag` config and the first-party beacon — NOT a fuller cookie-consent management flow.
- **Why:** (a) A full CMP (granular categories, vendor lists, consent-string/TCF) is disproportionate for
  a single-author personal portfolio with one analytics vendor (GA) + one owned beacon; the owner is the
  sole data controller. (b) The minimal banner closes the real gap — no non-essential identifier fires
  before a decision — which is what the regulatory exposure is about. (c) It is the verifier's recommended
  fix and the lowest-friction "right way."
- **Scope guardrails for the build:** default-deny (nothing fires until accept), decision persists across
  reloads, theme-consistent, keyboard-dismissible, respects `prefers-reduced-motion`. The gate logic
  (no send without the flag) is node:test-able; the banner appearance is the qa-verifier UX bullet.
- **Navigator note:** "dismiss without accepting" is treated as **decline** (suppress). If the owner wants
  dismiss-=-accept (more permissive), say so; default is the privacy-respecting reading.

### Decision 3 — FE-2 (chat-admin key reuse): **split a separate probe-scoped key** ✅
- **Chosen:** mint a dedicated probe-scoped credential for `/api/chat/smoke` (its own env secret on the
  chat container, timing-safe compare), and have the admin SPA send THAT key to the chat host — NOT the
  "accept with documented rationale" alternative.
- **Why:** The owner's "do everything the right way" directive tips a call that would otherwise be a
  reasonable ACCEPT. The accept rationale is sound (per-session sessionStorage key, HTTPS to the owner's
  own host, env-pinned per environment, timing-safe compare) and is why this is **P1, not P0** — but the
  durable correct posture is trust-domain separation: a compromise of the chat ECS host should not also
  unlock the contact admin. Splitting the key removes the cross-host blast-radius entirely.
- **Cost:** small — one new env secret on the chat container + the SPA sourcing a second key. Worth it
  given the directive.
- **Navigator note:** the admin SPA now needs to source two keys. Recommend the operator enters both at
  login (or derives the probe key), stored in sessionStorage like today. Confirm the UX is acceptable
  (qa-verifier will check the deep probe still works against staging after the split).

## Escalations / open navigator + dev-ops calls (do not silently choose)
- **Item 1 (Amplify env-guard):** how `GVP_EXPECTED_ENV` resolves per Amplify app — the `agent` app
  serves staging hosts, the `main` app serves prod hosts, so the guard's expected value must differ per
  branch/app. dev-ops to wire the per-app env in the Amplify console / `amplify.yml`.
- **Item 18 (per-IP rate limit):** WAF RuleGroup adds recurring AWS cost. Navigator/dev-ops call: WAF on a
  personal portfolio vs the cheaper DynamoDB conditional-write token-bucket. P1 floor (item 5: budget alarm
  + lowered amplification) ships regardless; item 18 is the deeper P2 choice.
- **STAGE-only target:** the promotion-procedure half of INFRA-1/FE-1 (re-pin PROD hosts on `main` after a
  fast-forward, per the 2026-06-04 hotfix `843e648`) is **NOT triggered** by this milestone — we deploy to
  staging, where the `agent` branch's staging hosts are correct. The STRUCTURAL `amplify.yml` guard (item 1)
  IS in scope and is the durable fix for the recurring incident. When prod is eventually promoted, the
  re-pin procedure still applies — record it in the prod-promotion runbook, out of scope here.

## Item → finding-id map (for traceability; full detail in the review output)
P0: 1=INFRA-1/FE-1(structural), 2=INFRA-2, 3=SEC-1, 4=SEC-2.
P1: 5=SEC-3(amplification+budget), 6=EV-4/SEC-4/INFRA-5, 7=EV-2, 8=FE-3, 9=SEC-7/CHAT-SMOKE-1,
    10=FE-2, 11=AGG-2, 12=FE-4.
P2: 13=AGG-3/TC-04, 14=AGG-1, 15=EV-3, 16=EV-1, 17=INFRA-4, 18=SEC-3(per-IP), 19=SEC-5, 20=TC-01,
    21=TC-02, 22=TC-03, 23=INFRA-6; INFRA-3 folded into item 2's template pass.

## Prior shipped (see backlog Shipped + progress.md)
Contact durability, chat invariants #7–#10, frontend guards #1/#2, invariant-completion pins,
Team Tactics contact CTA.
