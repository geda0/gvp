import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const cfg = readFileSync(join(REPO, '.claude/tdd.config'), 'utf8')
const pattern = (cfg.match(/^SECURITY_GLOB='(.*)'$/m) || [])[1]

// SECURITY_GLOB is the gate that forces a review before a credential surface changes. It
// covered `aws/(template|chat-template).yaml` and nothing else under aws/.
//
// That gap is not hypothetical: it is exactly how commit a6325d2 shipped the streaming half
// of the Secrets Manager migration (ADR-0025) with NO security review — new IAM granting
// secretsmanager:GetSecretValue, a new credential parameter, and a change to how the key
// reaches the function, all in `aws/chat-stream-template.yaml`, which the gate did not watch.
// Its gated sibling `chat-template.yaml` got a full architect review that produced two
// BLOCKING corrections — the SAM Policies shape, and the fact that adding the secret path
// does not remove the plaintext key. Both applied to the ungated file too, and both were
// only discovered afterwards. A gate watching one of two identical surfaces is a gate you
// cannot rely on.
//
// So the glob must cover every file that grants IAM or carries a credential into a runtime.
// Pinned as a test because a regex in a config file gets edited by people in a hurry, and
// the failure is silent: the edit simply goes through and nobody learns a review was skipped.

const MUST_BE_GATED = [
  // IAM + credential parameters + the environment that reaches the function.
  'aws/template.yaml',
  'aws/chat-template.yaml',
  'aws/chat-stream-template.yaml',
  // Grants lambda:InvokeFunctionUrl via OAC — an access-control surface.
  'aws/chat-stream-cdn-template.yaml',
  // Retired, but still carries the key in container env if anyone deploys it.
  'aws/chat-express-template.yaml',
  // Resolves the credential at runtime.
  'docker/chat/app/secret_resolver.py',
  // Added by M7/M8 (2026-10-23), and missed by the glob until this test named them:
  'aws/chat-waf-template.yaml',          // the per-IP rate ceiling in front of chat
  'aws/src/common/admin-auth.js',        // decides full vs read-only admin access
  'aws/src/common/site-alerts-core.js'   // parses public /api/events input into pages
]

// Deliberately NOT gated: these shape a deploy but grant nothing and hold no credential.
// A gate that blocks everyday edits gets routed around, and then protects nothing.
const MUST_NOT_BE_GATED = [
  'scripts/integrate-and-deploy.sh',
  'js/chat.js',
  'docker/chat/app/providers.py'
]

test('SECURITY_GLOB is parseable and non-empty', () => {
  assert.ok(pattern, 'could not read SECURITY_GLOB from .claude/tdd.config')
  assert.doesNotThrow(() => new RegExp(pattern), 'SECURITY_GLOB must be a valid regex')
})

test('every IAM- or credential-bearing file is gated', () => {
  const rx = new RegExp(pattern)
  const missing = MUST_BE_GATED.filter((f) => !rx.test(f))
  assert.deepEqual(
    missing, [],
    'these grant IAM or carry a credential and are NOT covered by SECURITY_GLOB: ' +
    `${missing.join(', ')}. That is how a6325d2 shipped new secretsmanager:GetSecretValue ` +
    'IAM with no review, while its identical sibling got a full one.'
  )
})

test('the glob stays targeted — it does not swallow ordinary files', () => {
  const rx = new RegExp(pattern)
  const over = MUST_NOT_BE_GATED.filter((f) => rx.test(f))
  assert.deepEqual(
    over, [],
    `SECURITY_GLOB now matches ${over.join(', ')}, which grant nothing and hold no ` +
    'credential. A gate that blocks everyday edits gets routed around, and then it protects ' +
    'nothing at all.'
  )
})

// Every CloudFormation template here creates IAM or security-relevant resources, so the rule
// is "all of aws/*.yaml", not a list a new template can be forgotten from - which is exactly
// how aws/chat-waf-template.yaml shipped ungated.
test('every template under aws/ is gated, including ones added after this test', async () => {
  const { readdirSync } = await import('node:fs')
  const rx = new RegExp(pattern)
  const templates = readdirSync(join(REPO, 'aws')).filter((f) => /\.ya?ml$/.test(f))
  const missing = templates.map((f) => `aws/${f}`).filter((f) => !rx.test(f))
  assert.deepEqual(missing, [], `ungated templates: ${missing.join(', ')}`)
})
