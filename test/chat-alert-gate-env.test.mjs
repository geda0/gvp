import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Instant chat alerting is gated, once, by `alerts_enabled()` in
// docker/chat/app/alerts.py — the SOURCE OF TRUTH for which env vars must reach the container.
// When it returns False, EMAIL delivery is skipped for all six alert types
// (chat_upstream_unavailable, chat_primary_timeout, chat_primary_rate_limit, chat_model_error,
// chat_transcript_write_failed, chat_transcript_session_full).
//
// CORRECTED 2026-10-07, same day, and the correction is the point of this note. This comment
// originally read "...returns silently: no log line, no counter. All six alert types are dropped
// without a trace." That was TRUE when this test was written and became FALSE within the hour,
// when commit 39e2033 added the unconditional Tier-1 WARNING line as the first statement of
// `fire_alert` (ADR-0022 §25 DECISION 5, project invariant 19). An unconfigured host now leaves a
// durable record, so the stakes of a missing env var are "no EMAIL" rather than "no trace".
// Deliberately NOT deleted: the superseded sentence is why this test exists, and a test whose
// stated justification silently overstates its own stakes is how a test outlives its reason.
// Line citations are kept coarse here on purpose — 39e2033 shifted alerts.py by +13 and the
// pinpoint `:85-86` style of citation went stale across three files at once.
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
  // Splits on `async def` as well as `def`: without it a chunk runs to EOF and swallows the
  // next coroutine. The tdd-critic verified this cannot move the gate groups, since none of
  // alerts_enabled / _dest_email / _from_email / _api_key is followed by an `async def` — so the
  // local workaround that used to live in envLabelEnvNames was duplicating this rule for a
  // reason that did not hold.
  for (const chunk of src.split(/^(?:async )?def /m).slice(1)) {
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
    ...(defs.get(helper) || '').matchAll(/os\.environ\.get\(\s*['\"]([A-Z][A-Z0-9_]*)['\"]/g)
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
  const body = pythonTopLevelDefs(alertsPy).get('_env_label') || ''
  return [...body.matchAll(/os\.environ\.get\(\s*['\"]([A-Z][A-Z0-9_]*)['\"]/g)].map(m => m[1])
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

// ─────────────────────────────────────────────────────────────────────────────────
// TIER 2 ON LAMBDA — the log-metric-filter chain. Project invariant 19 Tier 2,
// ADR-0022 §29 (DECISION 8), blocker B-3.
//
// WHY THIS IS NOW THE ENTIRE DELIVERY PATH AND NOT A SECOND BELT. MEASURED 2026-10-07
// (ADR-0022 §25.3-M): on a Lambda chat host `fire_alert`'s detached
// `loop.create_task(_send(...))` DOES NOT DELIVER. The synchronous Tier-1 `CHAT_ALERT` line
// appeared 2 times, while `alert sent event`, `alert send failed event` and `alert send
// errored` each appeared 0 times, and the function was never invoked again — the frozen task
// never resumed. Verdict: LOST. So on Lambda the in-process email is not a delivery mechanism
// at all: a CloudWatch Logs metric filter on the Tier-1 line -> alarm -> SNS is the ONLY way
// an alert reaches a human. The two tests above pin the env the EMAIL gate reads, which on
// these two hosts now buys attribution and a config invariant rather than delivery.
//
// PIN THE CHAIN, NOT A PIECE — every link is silent when broken. A MetricFilter cannot attach
// to a log group that does not exist, and Lambda's implicit `/aws/lambda/<fn>` is created on
// FIRST INVOCATION, so a fresh prod stack with a filter on that name fails the deploy
// (measured: neither Lambda template declares any `AWS::Logs::*` resource today). A log group
// nothing logs to collects nothing. A filter on the wrong group, or with a pattern that misses
// the line, publishes a metric that is permanently zero — and an alarm on a permanently-zero
// metric is indistinguishable from "all is well", which is the exact failure mode this
// invariant exists to end.
//
// SCOPE — `aws/chat-express-template.yaml` is deliberately NOT in this list and is NOT EXEMPT
// from Tier 2. Invariant 19 allows one of TWO delivery mechanisms per host, and the ECS Express
// host satisfies it by the OTHER one: a long-lived process whose in-process Resend send
// genuinely completes (precisely what the Lambda probe above disproves for Lambda), and it has
// no Lambda log group to hang a filter on. This list is about WHICH mechanism a host uses,
// never about WHETHER a host owes Tier 2.
//
// NOT ASSERTED, on purpose: that the SNS topic has a CONFIRMED subscription. That is runtime
// state, unknowable offline, and it is ADR-0022 B-5's job — this account currently holds two
// MEASURED non-delivering topics, one of them on prod, so "wired" and "delivering" are
// genuinely different claims and only the first is provable from the repo. Also not asserted:
// whether the chain's resources carry a `Condition:` (a chain gated off by a defaulted-empty
// parameter would be silent too, but which resource may legitimately be gated is a design the
// ADR has not fixed — left for its own slice rather than guessed at here).
const LAMBDA_CHAT_HOST_TEMPLATES = [
  'aws/chat-template.yaml', // Lambda behind HttpApi (BUFFERED)
  'aws/chat-stream-template.yaml' // Lambda RESPONSE_STREAM (ADR-0022)
]

// Resources split into `logicalId -> block text` by indentation, the same structural rule
// containerEnvVarNames() uses for `Environment:` — never a whole-file regex, so a logical id
// mentioned only in `Outputs:` or in prose cannot satisfy a link. No YAML library: these
// templates carry !Ref / !Sub / !GetAtt / !If intrinsics and there is no yaml dep.
function cfnResources (templateText) {
  const lines = templateText.split('\n')
  const start = lines.findIndex(l => /^Resources:\s*$/.test(l))
  const blocks = new Map()
  if (start < 0) return blocks
  let current = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line) && !line.startsWith('#')) break // next top-level section
    const opener = line.match(/^ {2}([A-Za-z0-9]+):\s*$/)
    if (opener) blocks.set((current = opener[1]), [])
    else if (current) blocks.get(current).push(line)
  }
  return new Map([...blocks].map(([id, body]) => [id, body.join('\n')]))
}

// The value of `key:` inside a block: the inline remainder plus any more-indented lines
// beneath it, so one extractor serves a scalar (`FilterPattern: '"x"'`), a nested map
// (`LoggingConfig:` -> `LogGroup: !Ref X`) and a list (`AlarmActions:` -> `- !Ref T`).
// Comment lines are skipped so template prose can never be read as a value.
function valueAt (text, key) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('#')) continue
    // The `(-\s+)?` accepts a key that is the FIRST entry of a list item, e.g.
    // `- MetricNamespace: GvpChat` under `MetricTransformations:`. Without it this
    // helper read MetricNamespace as absent, which made LINK 5 fail against a
    // CORRECT template and cascaded into LINK 6 — a false red, and the exact
    // "fails for the wrong reason" class this suite is supposed to catch.
    // The indent compared below is the KEY's column, not the dash's: a list item's
    // sibling keys line up with the key, so comparing against the dash's indent
    // would swallow every sibling into this key's value.
    const opener = lines[i].match(new RegExp(`^(\\s*)(-\\s+)?${key}:(.*)$`))
    if (!opener) continue
    const keyIndent = opener[1].length + (opener[2] ? opener[2].length : 0)
    const parts = [opener[3].trim()]
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || lines[j].trim().startsWith('#')) continue
      if (lines[j].match(/^\s*/)[0].length <= keyIndent) break
      parts.push(lines[j].trim())
    }
    return parts.filter(Boolean).join(' ')
  }
  return null
}

const idsOfType = (resources, type) =>
  [...resources]
    .filter(([, body]) => new RegExp(`^\\s*Type:\\s*${type}\\s*$`, 'm').test(body))
    .map(([id]) => id)

const unquote = s => (s || '').trim().replace(/^['"]|['"]$/g, '')
const mentions = (text, logicalId) => new RegExp(`\\b${logicalId}\\b`).test(text || '')

// The filter pattern must match the LINE, so it is DERIVED from the line's own format string
// rather than restated. `fire_alert`'s first WARNING-or-above log call IS the Tier-1 emission
// (docker/chat/app/alerts.py, invariant 19 Tier 1); everything before its first `%`
// placeholder is the literal text CloudWatch sees at the head of the message.
function tier1LinePrefix (alertsPy) {
  const body = pythonTopLevelDefs(alertsPy).get('fire_alert') || ''
  const call = body.match(/logger\.(?:warning|error|critical|exception)\(\s*['"]([^'"]*)['"]/)
  return call ? call[1].split('%')[0] : ''
}

// The same prefix as the Python suite pins it (docker/chat/tests/test_alerts.py TIER1_PREFIX).
// Deriving BOTH and asserting they AGREE is the point: the emitter, its unit pin and the
// metric filter are three files that must say one thing, and a test that restated the literal
// a third time would let the filter drift away from the line it is supposed to match.
function pinnedTier1Prefix (testAlertsPy) {
  const m = testAlertsPy.match(/^TIER1_PREFIX\s*=\s*['"]([^'"]*)['"]/m)
  return m ? m[1] : ''
}

test('both Lambda chat hosts alarm on the Tier-1 alert line via a metric filter on a log group they own', () => {
  const appPrefix = tier1LinePrefix(read('docker/chat/app/alerts.py'))
  const pinnedPrefix = pinnedTier1Prefix(read('docker/chat/tests/test_alerts.py'))

  assert.ok(
    pinnedPrefix.length > 0 && appPrefix.startsWith(pinnedPrefix),
    'the Tier-1 prefix must be DERIVED from the emitter and must agree with its unit pin — ' +
      `fire_alert()'s log format in docker/chat/app/alerts.py yields ${JSON.stringify(appPrefix)} ` +
      `and docker/chat/tests/test_alerts.py pins TIER1_PREFIX=${JSON.stringify(pinnedPrefix)}`
  )

  // A SPACE-DELIMITED CloudWatch pattern would not have matched either real event. MEASURED
  // 2026-10-07: the two observed `CHAT_ALERT` lines arrived CONCATENATED BEHIND A TRACEBACK
  // TAIL inside ONE CloudWatch event, so the prefix is not at a token boundary. Only a QUOTED
  // term — which matches a substring anywhere in the event — matches what was actually logged.
  const quotedTerm = `"${appPrefix}"`

  const broken = []
  const metricIdentity = new Map()

  for (const rel of LAMBDA_CHAT_HOST_TEMPLATES) {
    const resources = cfnResources(read(rel))
    assert.ok(
      resources.size > 0,
      `parsed no Resources at all out of ${rel} — fix the parse, not the template`
    )

    const logGroups = idsOfType(resources, 'AWS::Logs::LogGroup')
    const filters = idsOfType(resources, 'AWS::Logs::MetricFilter')
    const alarms = idsOfType(resources, 'AWS::CloudWatch::Alarm')
    const functions = [
      ...idsOfType(resources, 'AWS::Serverless::Function'),
      ...idsOfType(resources, 'AWS::Lambda::Function')
    ]

    // LINK 1 — the stack OWNS the log group it filters on.
    if (logGroups.length === 0) {
      broken.push(
        `${rel} LINK 1 (stack-owned log group): no AWS::Logs::LogGroup resource — a MetricFilter ` +
          `cannot attach to Lambda's implicit /aws/lambda/<fn>, which does not exist until the ` +
          `first invocation (resources: ${[...resources.keys()].join(', ')})`
      )
    }

    // LINK 2 — the function actually WRITES there. A declared-but-unreferenced log group is the
    // same defect class as the declared-but-never-passed Parameters: entry the gate test rejects.
    const wiredGroups = functions.flatMap(fn => {
      const cfg = valueAt(resources.get(fn), 'LoggingConfig')
      return logGroups.filter(lg => mentions(cfg, lg))
    })
    if (wiredGroups.length === 0) {
      broken.push(
        `${rel} LINK 2 (LoggingConfig -> that group): no function in [${functions.join(', ')}] ` +
          `points LoggingConfig.LogGroup at any of [${logGroups.join(', ') || 'none declared'}], ` +
          'so the Tier-1 lines never land in the group being filtered'
      )
    }

    // LINK 3 — a metric filter on THAT group, not on some other name.
    const target = wiredGroups.length ? wiredGroups : logGroups
    const filterId = filters.find(f =>
      target.some(lg => mentions(valueAt(resources.get(f), 'LogGroupName'), lg))
    )
    if (!filterId) {
      broken.push(
        `${rel} LINK 3 (metric filter on that group): no AWS::Logs::MetricFilter whose ` +
          `LogGroupName references [${target.join(', ') || 'none declared'}] ` +
          `(metric filters present: ${filters.join(', ') || 'none'})`
      )
    }
    const filter = filterId ? resources.get(filterId) : ''

    // LINK 4 — the pattern matches the Tier-1 line, as a QUOTED term.
    const pattern = valueAt(filter, 'FilterPattern')
    if (!filterId || !(pattern || '').includes(quotedTerm)) {
      broken.push(
        `${rel} LINK 4 (pattern matches the Tier-1 line): FilterPattern ` +
          `${JSON.stringify(pattern)} must contain the quoted term ${JSON.stringify(quotedTerm)} ` +
          '— derived from fire_alert()\'s own log format; a space-delimited pattern misses the ' +
          'measured events, which arrived concatenated behind a traceback tail'
      )
    }

    const namespace = unquote(valueAt(filter, 'MetricNamespace'))
    const metricName = unquote(valueAt(filter, 'MetricName'))
    const identity = `${namespace}/${metricName}`

    // LINK 5 — an alarm on THAT metric.
    const alarmId = alarms.find(
      id =>
        namespace !== '' &&
        metricName !== '' &&
        unquote(valueAt(resources.get(id), 'Namespace')) === namespace &&
        unquote(valueAt(resources.get(id), 'MetricName')) === metricName
    )
    if (!alarmId) {
      // The alarm identities are printed too, so a NEAR miss (the same metric spelled
      // `!Sub` in one place and `!Ref` in the other) reads as a near miss rather than as
      // an absence — the two are different fixes.
      const seen = alarms
        .map(
          id =>
            `${id}=${unquote(valueAt(resources.get(id), 'Namespace'))}/` +
            `${unquote(valueAt(resources.get(id), 'MetricName'))}`
        )
        .join(', ')
      broken.push(
        `${rel} LINK 5 (alarm on that metric): no AWS::CloudWatch::Alarm on the metric the filter ` +
          `publishes, ${JSON.stringify(identity)} (alarms present: ${seen || 'none'})`
      )
    }

    // LINK 6 — the alarm notifies a topic. WIRING ONLY: whether that topic delivers is B-5.
    const actions = alarmId ? valueAt(resources.get(alarmId), 'AlarmActions') : null
    if (!alarmId || !/(!Ref\s+\w+|!GetAtt\s+[\w.]+|arn:aws:sns)/.test(actions || '')) {
      broken.push(
        `${rel} LINK 6 (alarm notifies a topic): AlarmActions ${JSON.stringify(actions)} must ` +
          'reference a topic (wiring only — a CONFIRMED subscription is runtime state and is ADR-0022 B-5)'
      )
    }

    // LINK 7 — the metric identity carries the ENVIRONMENT. A metric filter cannot set a static
    // dimension, so stage and prod publishing to one namespace/name publish into ONE metric and
    // each alarms on the other's alert lines. The environment token is DERIVED from whatever
    // parameter the template already wires into CHAT_ENV — the same value _env_label() stamps on
    // the alert — so the metric and the alert cannot disagree about which environment they name.
    const envParam = functions
      .map(fn => (valueAt(resources.get(fn), 'CHAT_ENV') || '').match(/!Ref\s+(\w+)/))
      .map(m => m && m[1])
      .find(Boolean)
    if (!envParam) {
      broken.push(
        `${rel} LINK 7 (environment in the metric name): CHAT_ENV is not wired to a template ` +
          'parameter, so there is no environment token for the metric identity to carry'
      )
    } else if (!mentions(identity, envParam)) {
      broken.push(
        `${rel} LINK 7 (environment in the metric name): metric identity ${JSON.stringify(identity)} ` +
          `must interpolate \${${envParam}} — the same parameter CHAT_ENV uses — or stage and prod ` +
          'publish into one metric and each alarms on the other environment\'s alert lines'
      )
    }

    if (filterId) metricIdentity.set(rel, identity)
  }

  // LINK 8 — and the two HOSTS must not collide either, for the same dimensionless-metric reason.
  const [httpApiHost, streamHost] = LAMBDA_CHAT_HOST_TEMPLATES
  if (
    metricIdentity.has(httpApiHost) &&
    metricIdentity.has(streamHost) &&
    metricIdentity.get(httpApiHost) === metricIdentity.get(streamHost)
  ) {
    broken.push(
      `LINK 8 (distinct metric per host): ${httpApiHost} and ${streamHost} both publish to ` +
        `${JSON.stringify(metricIdentity.get(httpApiHost))} — one alarm would fire on the other ` +
        "host's alert lines"
    )
  }

  assert.deepEqual(
    broken,
    [],
    'these Lambda chat hosts have no path from a fired alert to a human — the in-process email ' +
      'is MEASURED LOST on Lambda, so each broken link below is total loss, not degraded delivery:\n' +
      broken.join('\n')
  )
})
