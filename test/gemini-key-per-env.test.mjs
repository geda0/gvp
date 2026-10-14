import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(REPO, 'scripts/lib/gemini-key.sh')

// Stage and prod share ONE Gemini API key, and that is a capacity bug with teeth.
//
// MEASURED on the deployed functions, 2026-10-14: the GEMINI_API_KEY on
// gvp-chat-lambda-stream-prod-* and gvp-chat-lambda-stream-stage-* have the SAME sha256
// fingerprint (b35892d1…). The free-tier quota
// `GenerateContentInputTokensPerModelPerMinute-FreeTier` = 16,000 input tokens/minute is
// scoped PER PROJECT, PER MODEL — so it is one shared budget across both environments.
//
// The consequence was observed the same day. Verifying the cache fix on stage (9 turns)
// exhausted flash-lite, and minutes later a 4-turn check against PROD returned HTTP 429 on
// turns 3 and 4, with prod's own telemetry showing every turn falling to the cold fallback:
//
//   gemini usage model=gemma-4-26b-a4b-it prompt=7080 cached=0 cached_pct=0 billable=7080
//
// So load-testing staging degrades production chat for real visitors, and nothing in the
// deploy path says so. There is no isolation seam between environments on the model side —
// only on the AWS side.
//
// This pins a per-environment key with a documented fallback. It deliberately does NOT
// mirror the CHAT_SAM_STACK_NAME collision guard, which *refuses* when both arms resolve to
// one stack: that is a CORRECTNESS bug (prod parameters written into the stage stack, i.e.
// corruption), whereas a shared key only costs capacity. Refusing here would break every
// existing deploy on day one for a problem that degrades rather than destroys. So: resolve
// per environment, fall back to the shared name, and WARN loudly when both arms land on the
// same key, naming the consequence.
//
// The logic lives in a sourceable helper rather than inline in integrate-and-deploy.sh so it
// can be driven directly. Sourcing the monolith would execute a deploy.

const sh = (env, deployEnv) => {
  const out = execFileSync(
    '/bin/bash',
    ['-c', `set -euo pipefail; . "${LIB}"; resolve_gemini_key "${deployEnv}"; printf '%s' "$GEMINI_API_KEY_RESOLVED"`],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return out
}

const shWithWarning = (env, deployEnv) => {
  // stderr is where the hazard warning must go, so capture the two streams separately.
  const res = execFileSync(
    '/bin/bash',
    ['-c', `. "${LIB}"; resolve_gemini_key "${deployEnv}" 2>/tmp/gvp_key_warn; printf '%s' "$GEMINI_API_KEY_RESOLVED"; printf '\\n--STDERR--\\n'; cat /tmp/gvp_key_warn`],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const [resolved, stderr = ''] = res.split('\n--STDERR--\n')
  return { resolved, stderr }
}

test('the helper exists and is sourceable without running a deploy', () => {
  assert.ok(
    existsSync(LIB),
    'scripts/lib/gemini-key.sh must exist — the resolution has to be drivable without ' +
    'sourcing integrate-and-deploy.sh, which would execute a deploy'
  )
  const body = readFileSync(LIB, 'utf8')
  assert.match(
    body, /resolve_gemini_key\s*\(\)/,
    'the helper must define resolve_gemini_key()'
  )
})

test('each environment resolves its own key when both are set', () => {
  const env = {
    GEMINI_API_KEY_PROD: 'prod-key-aaa',
    GEMINI_API_KEY_STAGE: 'stage-key-bbb',
    GEMINI_API_KEY: 'shared-key-ccc',
  }
  assert.equal(sh(env, 'prod'), 'prod-key-aaa', 'prod must take GEMINI_API_KEY_PROD')
  assert.equal(sh(env, 'stage'), 'stage-key-bbb', 'stage must take GEMINI_API_KEY_STAGE')
})

test('the shared key is still honoured as a fallback, so existing deploys keep working', () => {
  const env = { GEMINI_API_KEY: 'shared-key-ccc' }
  assert.equal(sh(env, 'prod'), 'shared-key-ccc')
  assert.equal(sh(env, 'stage'), 'shared-key-ccc')
})

test('a per-env key overrides the shared one for that environment only', () => {
  const env = { GEMINI_API_KEY: 'shared-key-ccc', GEMINI_API_KEY_STAGE: 'stage-key-bbb' }
  assert.equal(sh(env, 'stage'), 'stage-key-bbb', 'stage override must win')
  assert.equal(sh(env, 'prod'), 'shared-key-ccc', 'prod keeps the shared key until given its own')
})

test('sharing one key across both environments warns, and says what it costs', () => {
  const { resolved, stderr } = shWithWarning({ GEMINI_API_KEY: 'shared-key-ccc' }, 'stage')

  assert.equal(resolved, 'shared-key-ccc', 'it must still resolve — this is a warning, not a refusal')
  assert.notEqual(stderr.trim(), '', 'a shared key must produce a warning on stderr')

  // The warning has to carry the consequence, or it reads as noise and gets ignored.
  const lowered = stderr.toLowerCase()
  assert.ok(
    /quota|16,?000|tokens per minute/.test(lowered),
    `the warning must name the shared quota as the mechanism. Got: ${stderr}`
  )
  assert.ok(
    /prod/.test(lowered) && /stage|staging/.test(lowered),
    `the warning must say BOTH environments are affected. Got: ${stderr}`
  )
})

test('distinct keys produce no warning, so the signal stays meaningful', () => {
  const { stderr } = shWithWarning(
    { GEMINI_API_KEY_PROD: 'prod-key-aaa', GEMINI_API_KEY_STAGE: 'stage-key-bbb' },
    'stage'
  )
  assert.equal(
    stderr.trim(), '',
    'once the keys are separated there must be nothing to warn about, or the warning ' +
    `becomes background noise. Got: ${stderr}`
  )
})

test('integrate-and-deploy.sh uses the helper rather than GEMINI_API_KEY directly', () => {
  const script = readFileSync(join(REPO, 'scripts/integrate-and-deploy.sh'), 'utf8')
  assert.match(
    script, /lib\/gemini-key\.sh/,
    'the deploy script must source scripts/lib/gemini-key.sh — a helper nothing calls is the ' +
    'starfield depth-fade bug again (defined, tested, never wired)'
  )
  assert.match(
    script, /resolve_gemini_key/,
    'the deploy script must call resolve_gemini_key for the active environment'
  )
})
