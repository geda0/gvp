import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')

// Does configuring Secrets Manager actually REMOVE the plaintext key, or merely add a
// second way to get it?
//
// This test exists because of a wrong premise of mine. I reasoned that "until the host
// reads the secret, the plaintext copy survives on prod" — implying that wiring the secret
// path closes the disclosure. It does not. The plaintext copy survives AFTER the host starts
// reading the secret, and the already-migrated stream host proved it:
//
//   gvp-chat-lambda-stream-prod-ChatStreamFunction-*  (2026-10-14)
//     GEMINI_API_KEY            present, 53 chars, sha256 9f9e579e…   <-- the ROTATED key
//     GEMINI_API_KEY_SECRET_ARN …secret:gvp/gemini-api-key-prod-fMLN1Z
//
// So after a migration that was supposed to fix a disclosure, the freshly rotated key was
// still one `lambda:GetFunctionConfiguration` call away — which is the exact vector that
// leaked the previous key into a session transcript in the first place. A change that claims
// to fix a disclosure while leaving it in place is worse than no change, because it retires
// the worry without retiring the risk.
//
// Nor can the deploy script fix it by passing an empty value: SAM rejects a bare `Key=` for
// these PackageType: Image stacks (recorded as measured in integrate-and-deploy.sh), and
// CloudFormation reuses the PREVIOUS value of an omitted parameter, so dropping the override
// does not clear it on a live stack either.
//
// The template has to do it, declaratively: when an ARN is configured, emit no plaintext key
// at all. That is deterministic — it holds no matter what the NoEcho parameter still carries
// in the stack, and it closes the "operator sets both" hygiene hole with the same line.
//
// Deliberate consequence: the resolver's fail-open fallback becomes unreachable whenever an
// ARN is set. That is the right trade here. The fallback only has value when a plaintext key
// is present, and a plaintext key present IS the disclosure. The failure mode stays loud
// rather than silent — stderr from the resolver, 503 gemini_key_missing on the voice mint,
// 503 on /ready, and the Tier-1 alert filter — and break-glass is a redeploy with an empty
// ARN, which is minutes.

// Both chat hosts run the same app and both held the key. chat-template.yaml is on
// SECURITY_GLOB; it is pinned here anyway, because a gate is a review requirement, not an
// exemption from the invariant.
const TEMPLATES = [
  'aws/chat-stream-template.yaml',
  'aws/chat-template.yaml'
]

for (const rel of TEMPLATES) {
  test(`${rel}: the plaintext key is omitted when a secret ARN is configured`, () => {
    const body = read(rel)

    // Find the GEMINI_API_KEY environment assignment (not the parameter declaration).
    const line = body
      .split('\n')
      .find((l) => /^\s+GEMINI_API_KEY:\s/.test(l))

    assert.ok(
      line,
      `${rel} has no GEMINI_API_KEY environment entry at all — if the key moved, update this ` +
      'test; if it was dropped by accident the app cannot authenticate'
    )

    assert.match(
      line, /!If/,
      `${rel} assigns GEMINI_API_KEY unconditionally:\n    ${line.trim()}\n` +
      'That leaves the key readable via lambda:GetFunctionConfiguration even once the secret ' +
      'path works — measured on the stream prod host on 2026-10-14, holding the freshly ' +
      "ROTATED key. Use !If [HasGeminiSecret, !Ref 'AWS::NoValue', !Ref GeminiApiKey] so the " +
      'environment carries no key when an ARN is set.'
    )
    assert.match(
      line, /AWS::NoValue/,
      `${rel}'s GEMINI_API_KEY is conditional but does not resolve to AWS::NoValue, so the ` +
      `key is still emitted in some branch:\n    ${line.trim()}`
    )
    assert.match(
      line, /HasGeminiSecret/,
      `${rel} must key the condition on HasGeminiSecret (the ARN being non-empty), not on ` +
      `anything else:\n    ${line.trim()}`
    )
  })

  test(`${rel}: the secret ARN is readable and scoped to exactly one secret`, () => {
    const body = read(rel)

    assert.match(
      body, /GEMINI_API_KEY_SECRET_ARN:\s*!Ref GeminiApiKeySecretArn/,
      `${rel} must pass the ARN into the function environment, or app/secret_resolver.py has ` +
      'nothing to read and silently does nothing'
    )
    assert.match(
      body, /secretsmanager:GetSecretValue/,
      `${rel} must grant secretsmanager:GetSecretValue, or the resolver fails at every cold ` +
      'start and the host falls back to a key that is no longer there'
    )
    assert.match(
      body, /Resource:\s*!Ref GeminiApiKeySecretArn/,
      `${rel} must scope the grant to the one !Ref'd ARN. A wildcard would trade a plaintext ` +
      'env var for read access to every secret in the account — worse than the problem.'
    )
    assert.doesNotMatch(
      body, /Action:\s*secretsmanager:\*/,
      `${rel} grants secretsmanager:* — read only, and on one resource`
    )
  })
}

test('the ARN parameter rejects a name-only ARN, which silently denies', () => {
  // A Secrets Manager ARN without the 6-character suffix does not match the resource in an
  // IAM policy, so the grant denies and the resolver falls back — looking like a config
  // problem rather than a typo. Cheap to refuse at the parameter.
  for (const rel of TEMPLATES) {
    const body = read(rel)
    const block = body.slice(body.indexOf('GeminiApiKeySecretArn:'))
    assert.match(
      block.slice(0, 600), /AllowedPattern/,
      `${rel}: GeminiApiKeySecretArn needs an AllowedPattern requiring the full ARN including ` +
      'its 6-char suffix. A name-only ARN silently denies rather than failing the deploy.'
    )
  }
})

test('the deploy script passes the ARN to BOTH chat stacks, not just the streaming one', () => {
  const script = read('scripts/integrate-and-deploy.sh')
  const count = (script.match(/GeminiApiKeySecretArn/g) || []).length
  assert.ok(
    count >= 2,
    `GeminiApiKeySecretArn appears ${count} time(s) in the deploy script. Both chat stacks ` +
    'need it: the buffered host serves the voice mint, transcripts and admin, and if the ' +
    'parameter is never passed the template default wins, the ARN deploys empty, and the ' +
    'resolver returns without doing anything.'
  )
})
