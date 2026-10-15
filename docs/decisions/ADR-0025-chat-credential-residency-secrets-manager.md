# ADR-0025 — Chat credential residency: Secrets Manager, and no plaintext copy

Status: Accepted
Date: 2026-10-15
Supersedes: none (amends the credential wiring introduced across ADR-0007 and ADR-0022)
References: ADR-0008 (same posture: this ADR **is** the deliberate security review for this surface)

## Context

`GEMINI_API_KEY` reaches both chat hosts as a **NoEcho** CloudFormation parameter. NoEcho
protects the value in `describe-stacks` and in the console — and then the templates place it
in the Lambda **function environment**, where `lambda:GetFunctionConfiguration` returns it in
plaintext to any principal holding that permission.

That is not a theoretical surface. On **2026-10-14** the prod key was disclosed into a
session transcript by an ordinary read of the function configuration during unrelated
debugging. The owner then rotated the prod credential (39-char key → 53-char key, stored in
`gvp/gemini-api-key-prod`).

Two facts made the obvious fix insufficient, and both were measured rather than reasoned:

1. **Adding the Secrets Manager path does not remove the plaintext copy.** After `a6325d2`
   wired the streaming host to read the secret, that host still carried the key in its
   environment — and after the rotation it carried the *new* key there. A migration intended
   to close a disclosure left the disclosure open, now holding a fresher credential.
2. **The deploy path cannot clear it.** `sam deploy` rejects a bare `Key=` override for these
   `PackageType: Image` stacks (recorded as measured in `scripts/integrate-and-deploy.sh`),
   and CloudFormation **reuses the previous value** of an omitted parameter, so dropping the
   override does not clear it on a live stack either.

A third fact reframed the urgency: rotating prod **demoted the disclosed credential to
staging** rather than retiring it. Relocating a published key does not unpublish it.

## Decision

### 1. Secrets Manager is where the chat credential lives

One secret **per environment** — `gvp/gemini-api-key-prod`, `gvp/gemini-api-key-stage`. Per
environment for the same reason the keys themselves are per environment: the free-tier quota
`GenerateContentInputTokensPerModelPerMinute-FreeTier` is scoped per *project* per *model*, so
a shared credential means a shared budget and a staging soak degrades production. One secret
serving both would re-create that coupling in a new place.

### 2. When an ARN is configured, the plaintext key is NOT emitted

Both templates assign:

```yaml
GEMINI_API_KEY: !If [HasGeminiSecret, !Ref 'AWS::NoValue', !Ref GeminiApiKey]
```

The environment then carries **no `GEMINI_API_KEY` key at all**, regardless of what the NoEcho
parameter still holds in the stack. This is deliberately **declarative rather than
procedural**: it holds without operator discipline, it cannot be undone by a deploy that
forgets a flag, and it closes the "operator sets both" hygiene hole with the same line.

**Accepted consequence:** `secret_resolver`'s fail-open fallback becomes unreachable while an
ARN is set. That is the correct trade, because the fallback only has value when a plaintext
key is present — and a plaintext key present *is* the disclosure this ADR exists to remove.
The failure mode stays loud rather than silent: the resolver announces on stderr,
`POST /api/live/session` returns `503 gemini_key_missing`, `/ready` returns 503, and the
Tier-1 alert metric filter fires. Break-glass is a redeploy with `GeminiApiKeySecretArn=''`,
which is minutes.

### 3. Resolution happens once, at bootstrap, into the process environment

`docker/chat/app/secret_resolver.py`, invoked at `app.providers` import time. The key is read
in six places across four modules, two of them on `SECURITY_GLOB`; resolving into
`os.environ` means every existing read site works unchanged and the gated modules are not
touched. `main.py` imports `app.providers` at module scope and reads the key only inside
functions, so the ordering holds — and that ordering is asserted, not assumed.

The bootstrap outcome is announced on **stderr** as well as the logger, because it runs
before the root logger is configured and was otherwise invisible. The value is never logged,
only its length: CloudWatch is readable by anyone with `logs:FilterLogEvents`, which is the
same class of surface being closed.

### 4. IAM is read-only, on one resource

`secretsmanager:GetSecretValue` on the single `!Ref`'d ARN, conditional on an ARN being
configured. No `ListSecrets`, no wildcard, no `kms:*` — the secrets use the AWS-managed
`aws/secretsmanager` key, whose key policy grants decrypt to account principals through the
service, so no explicit `kms:Decrypt` is required. A wildcard here would trade a plaintext
env var for read access to every secret in the account, which is worse than the problem.

**If a customer-managed key is ever used**, `GetSecretValue` fails with an `AccessDenied` from
KMS and the host loses chat (per decision 2 the fallback is gone). A CMK would additionally
need `kms:Decrypt` on the key ARN in this policy *and* a matching key-policy grant.

### 5. The ARN parameter refuses a name-only ARN

`AllowedPattern` requires the full ARN including its 6-character suffix. A name-only ARN does
not match the IAM policy `Resource`, so the grant silently **denies** — presenting as a
configuration problem rather than a typo.

### 6. Template shape differs between the two hosts, and that is not cosmetic

`aws/chat-stream-template.yaml` declares an explicit `AWS::IAM::Role`, whose `Policies` take
`{PolicyName, PolicyDocument}`. `aws/chat-template.yaml` uses SAM's
`AWS::Serverless::Function` `Policies` with an implicit role, which takes the `Statement:`
form. Copying the former into the latter fails the SAM transform
(`InvalidResourceException … Policy at index 1 … is not valid`). Measured both ways.

## Consequences

- `lambda:GetFunctionConfiguration` no longer discloses the chat credential on any host with
  an ARN configured.
- Rotation becomes one `put-secret-value` with **no redeploy** — the next cold start picks it
  up. That is the operational win, and it is why the secret is the source of truth rather than
  a deploy-time convenience.
- Losing Secrets Manager loses chat on that host. See decision 2 for why that is accepted, and
  the filed-forward item below for the mitigation.
- `.secrets/chat-deploy.env`, the GitHub Actions secret store, and CloudFormation parameter
  history remain copies of the credential. This ADR narrows the *runtime* surface, not every
  copy.

## This ADR is the security review

`aws/chat-template.yaml` is on `SECURITY_GLOB`, which refuses edits until an architect or
security review has happened. Following ADR-0008's posture, **this document is that review**
for the credential-residency surface, and it records the review's findings rather than merely
asserting that one occurred. The review raised two blocking corrections — the SAM `Policies`
shape (decision 6) and the fact that the template-only change would have been a no-op on the
actual exposure (decision 2) — both of which are folded in above, and both of which corrected
a wrong premise in the original proposal.

### Post-deploy verification, all three or the migration is unverified

1. the host's log shows `[secret_resolver] resolved GEMINI_API_KEY from Secrets Manager (N chars)` on a cold start;
2. `get-function-configuration` shows **no `GEMINI_API_KEY` key**;
3. `POST /api/live/session` succeeds once — it is the route whose credential path changes, and
   the mint client is a cold-start singleton.

### Deploy-time preconditions

- Full ARNs including the suffix, **matched to `StageName`**. Passing the prod ARN to the stage
  stack would give the stage role read access to the prod secret; CloudFormation has no
  string-contains intrinsic to catch it, so this is a procedural control.
- Both secrets are **bare strings** today. `_extract` also accepts JSON, but a console re-save
  as JSON must use the key `GEMINI_API_KEY`, `gemini_api_key`, or `apiKey`.
- Neither function is VPC-attached, so Secrets Manager is reachable over the public endpoint.
  VPC-attaching one later requires an interface endpoint or NAT, or every cold start fails.

## Filed forward — explicitly NOT in this slice

1. **The disclosed 39-char key is still live, serving staging.** Rotating prod demoted it
   rather than retiring it. It must be deleted at the provider and staging given a fresh key
   of its own. This outranks everything else here: no IAM change mitigates a published
   credential that still works.
2. **Lazy re-resolution.** `resolve_gemini_key_into_env()` runs once per process and caches, so
   one failed cold start disables that container for its whole warm life rather than for one
   request. Re-attempting at the chain factory and the mint entry would bound the damage — it
   touches gated modules, so it is its own slice.
3. **`SECURITY_GLOB` drift.** The glob covers `aws/(template|chat-template)\.yaml` only.
   `chat-stream-template.yaml` and `chat-express-template.yaml` both carry IAM and credential
   wiring and are ungated — which is how `a6325d2` shipped the streaming half of this very
   decision with no security review.
4. **`ADMIN_API_KEY` is not declared** in `chat-template.yaml`'s environment, so
   `/api/chat/host-status` is permanently 401 on that host; `SMOKE_PROBE_KEY` deploys empty on
   prod, so `/api/chat/smoke` is permanently closed. Both fail closed, so neither is a
   vulnerability — but both are dead diagnostics.
5. **The surviving ECS Express task definition** still carries the key in container env.
6. **Deploys authenticate as the account root user**, which holds unconditional
   `GetFunctionConfiguration` and `GetSecretValue`. A scoped CI role already exists.
7. **The disclosure vector was a session transcript, not AWS.** No IAM change addresses it; the
   control is procedural — do not print function configuration.
