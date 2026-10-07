import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Instant chat alerting is gated, once, by `alerts_enabled()` in
// docker/chat/app/alerts.py:53-54 — the SOURCE OF TRUTH for which env vars must reach the
// container. When it returns False, `fire_alert()` returns silently (alerts.py:85-86): no log
// line, no counter. All six alert types (chat_upstream_unavailable, chat_primary_timeout,
// chat_primary_rate_limit, chat_model_error, chat_transcript_write_failed,
// chat_transcript_session_full) are dropped without a trace.
//
// MEASURED 2026-10-07 on the deployed functions: `alerts_enabled()` is False on BOTH Lambda
// chat hosts (gvp-chat-lambda-stream-stage-ChatStreamFunction-*, 7 env keys; and
// gvp-chat-stage-ChatFunction-*, 11 env keys), and True only on ECS Express. So alerting is
// today a property of the ECS HOST rather than of the APP — and the ADR-0022 migration moves
// prod off that host. This pins the gate to every template that can serve POST /api/chat.
//
// Scope: ONLY the alert gate. Deliberately NOT full env parity between the hosts — AWS_REGION
// (a Lambda reserved key), CHAT_READY_VERBOSE (a stage diagnostic) and CHAT_LIVE_RELAY /
// CHAT_LIVE_VOICE_STRICT (the retired relay transport) are legitimate divergences, and the
// gate needs no exclusion list to be correct.

const REPO = fileURLToPath(new URL('..', import.meta.url))

const read = rel => readFileSync(join(REPO, rel), 'utf8')

// Every template that can serve POST /api/chat, i.e. that runs docker/chat/app. The CDN
// template (chat-stream-cdn-template.yaml) is excluded on purpose: it runs no container.
const CHAT_HOST_TEMPLATES = [
  'aws/chat-express-template.yaml', // ECS Express (prod + staging today)
  'aws/chat-template.yaml', // Lambda behind HttpApi
  'aws/chat-stream-template.yaml' // Lambda RESPONSE_STREAM (ADR-0022)
]

// The required env names are DERIVED from alerts.py rather than hardcoded, so the test cannot
// drift away from the gate it protects (a renamed var, or a new fallback name, moves both at
// once). Each top-level `def` body is taken up to the next top-level `def`.
function pythonTopLevelDefs (src) {
  const defs = new Map()
  for (const chunk of src.split(/^def /m).slice(1)) {
    const named = chunk.match(/^(\w+)/)
    if (named) defs.set(named[1], chunk)
  }
  return defs
}

// -> [['CHAT_ALERT_EMAIL','CONTACT_REPORT_EMAIL'], ['CHAT_ALERT_FROM_EMAIL',...], ['RESEND_API_KEY']]
// One group per conjunct of `alerts_enabled()`; within a group the names are ALTERNATIVES
// (`os.environ.get(A) or os.environ.get(B)`), so any one of them satisfies that conjunct.
function alertGateEnvGroups (alertsPy) {
  const defs = pythonTopLevelDefs(alertsPy)
  const gate = defs.get('alerts_enabled') || ''
  // \b before the underscore so `alerts_enabled()` does not self-match as `_enabled()`.
  const helpers = [...gate.matchAll(/\b(_\w+)\(\)/g)].map(m => m[1])
  return helpers.map(helper => [
    ...(defs.get(helper) || '').matchAll(/os\.environ\.get\(\s*'([A-Z][A-Z0-9_]*)'/g)
  ].map(m => m[1]))
}

// Env var names DECLARED ON THE CONTAINER, read structurally from inside each `Environment:`
// block only — never from the whole file. A `Parameters:` entry named `ResendApiKey`, or the
// var names mentioned in chat-stream-template.yaml's `Description` prose, must NOT satisfy
// this: a parameter that is declared but never passed is the exact defect being pinned.
// Handles both shapes: the Lambda map (`Variables:` -> `NAME: !Ref X`) and the ECS container
// list (`- { Name: NAME, Value: ... }`).
function containerEnvVarNames (templateText) {
  const lines = templateText.split('\n')
  const names = new Set()
  for (let i = 0; i < lines.length; i++) {
    const opener = lines[i].match(/^(\s*)Environment:\s*$/)
    if (!opener) continue
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue
      if (lines[j].match(/^\s*/)[0].length <= opener[1].length) break // block ended
      const mapped = lines[j].match(/^\s*([A-Z][A-Z0-9_]*)\s*:/)
      if (mapped) names.add(mapped[1])
      const listed = lines[j].match(/^\s*-\s*\{?\s*Name:\s*([A-Z][A-Z0-9_]*)\b/)
      if (listed) names.add(listed[1])
    }
  }
  return names
}

test('every chat-host template wires the env vars alerts_enabled() gates on', () => {
  const groups = alertGateEnvGroups(read('docker/chat/app/alerts.py'))

  assert.ok(
    groups.length > 0 && groups.every(g => g.length > 0),
    `could not derive the alert gate env names from docker/chat/app/alerts.py:53-54 — ` +
      `alerts_enabled() must stay a conjunction of os.environ.get('NAME') helpers ` +
      `(derived: ${JSON.stringify(groups)})`
  )

  const gaps = []
  for (const rel of CHAT_HOST_TEMPLATES) {
    const declared = containerEnvVarNames(read(rel))
    assert.ok(
      declared.size > 0,
      `parsed no container env vars at all out of ${rel} — fix the parse, not the template`
    )
    for (const alternatives of groups) {
      if (!alternatives.some(name => declared.has(name))) {
        gaps.push(`${rel} (${declared.size} env vars) is missing: ${alternatives.join(' or ')}`)
      }
    }
  }

  assert.deepEqual(
    gaps,
    [],
    'these chat hosts drop every alert silently — alerts_enabled() is False there:\n' +
      gaps.join('\n')
  )
})

// A SEPARATE behavior from the gate above, not another assertion on it: CHAT_ENV is NOT part of
// `alerts_enabled()` and can never stop an alert from sending. It is read by `_env_label()`
// (docker/chat/app/alerts.py:97-103) and interpolated into the subject at :110-111 as
// `[chat alert · {env}] ...`. Missing it does not lose the alert, it loses the ATTRIBUTION.
//
// MEASURED 2026-10-07 on both deployed Lambda functions: `_env_label()` resolves to its
// 'unknown' fallback, so every alert either Lambda host sends is unattributable. With stage and
// prod both behind CloudFront front doors, an alert you cannot attribute to an environment
// cannot tell you whether PRODUCTION is burning.
//
// `_env_label()` is one `or` chain, so this is ONE alternation group — any of CHAT_ENV / STAGE /
// ENVIRONMENT satisfies it, exactly as the gate's two-name groups work. The names are DERIVED
// from alerts.py with the same two helpers, not hardcoded, so a rename moves both at once.
//
// All three chat hosts are asserted, not just the two Lambdas: the ECS Express host is
// INCLUDED AND ALREADY PASSING (chat-express-template.yaml:172 declares CHAT_ENV), it is NOT
// exempt. Only the Lambda hosts are expected to be in the gap list.
//
// PRESENCE OF THE KEY ONLY — this test must NEVER assert the VALUE. The value is a deploy-time
// parameter, and a test that pins values becomes a secret-shaped liability. Same for any
// successor to this test.
function envLabelEnvNames (alertsPy) {
  // Truncated at the next `def`: pythonTopLevelDefs splits only on top-level `def `, and
  // `_env_label` is followed by `async def _send`, whose body must not leak into the group.
  const body = (pythonTopLevelDefs(alertsPy).get('_env_label') || '').split(/\n(?:async )?def /)[0]
  return [...body.matchAll(/os\.environ\.get\(\s*'([A-Z][A-Z0-9_]*)'/g)].map(m => m[1])
}

test('every chat-host template declares the env var that attributes an alert to an environment', () => {
  const alternatives = envLabelEnvNames(read('docker/chat/app/alerts.py'))

  assert.ok(
    alternatives.length > 0,
    `could not derive the env label names from docker/chat/app/alerts.py:97-103 — ` +
      `_env_label() must stay a chain of os.environ.get('NAME') fallbacks ` +
      `(derived: ${JSON.stringify(alternatives)})`
  )

  const gaps = []
  for (const rel of CHAT_HOST_TEMPLATES) {
    const declared = containerEnvVarNames(read(rel))
    assert.ok(
      declared.size > 0,
      `parsed no container env vars at all out of ${rel} — fix the parse, not the template`
    )
    if (!alternatives.some(name => declared.has(name))) {
      gaps.push(`${rel} (${declared.size} env vars) is missing: ${alternatives.join(' or ')}`)
    }
  }

  assert.deepEqual(
    gaps,
    [],
    'every alert these chat hosts send is labelled [chat alert · unknown] — you cannot tell ' +
      'stage from prod:\n' + gaps.join('\n')
  )
})
