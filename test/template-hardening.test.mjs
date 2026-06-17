import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The SAM template uses CloudFormation short tags (!Ref / !GetAtt) that break
// generic YAML parsers, so this contract is asserted against the file TEXT with
// targeted regex/string checks — an acceptable infra-contract guard.
const templatePath = fileURLToPath(new URL('../aws/template.yaml', import.meta.url))
const template = readFileSync(templatePath, 'utf8')
const chatTemplatePath = fileURLToPath(new URL('../aws/chat-template.yaml', import.meta.url))
const chatTemplate = readFileSync(chatTemplatePath, 'utf8')
const chatExpressTemplatePath = fileURLToPath(new URL('../aws/chat-express-template.yaml', import.meta.url))
const chatExpressTemplate = readFileSync(chatExpressTemplatePath, 'utf8')

test('SAM template declares report-reliability, DR, and cron-stagger hardening (ADR-0009 S7+S23+S24)', () => {
  // --- S7 (INFRA-2): Lambda Errors alarms for both scheduled report functions ---
  // Split the template into per-alarm blocks at each `Type: AWS::CloudWatch::Alarm`
  // boundary so a lazy `[\s\S]*?` can't bleed across resources (e.g. match `Errors`
  // from one alarm against `ContactAlarmTopic` in a LATER block). Each block then
  // stands alone: deleting a single alarm's Threshold or AlarmActions fails the test.
  const alarmBlocks = template
    .split(/Type:\s*AWS::CloudWatch::Alarm/)
    .slice(1) // drop the preamble before the first alarm
  const alarmBlockFor = functionRef =>
    alarmBlocks.find(b => new RegExp(`Value:\\s*!Ref ${functionRef}\\b`).test(b))

  const dailyReportAlarm = alarmBlockFor('DailyReportFunction')
  assert.ok(
    dailyReportAlarm,
    'expected a CloudWatch::Alarm block dimensioned on Value: !Ref DailyReportFunction'
  )
  for (const needle of [
    /Namespace:\s*AWS\/Lambda/,
    /MetricName:\s*Errors/,
    /Threshold:\s*1\b/,
    /ContactAlarmTopic/
  ]) {
    assert.match(
      dailyReportAlarm,
      needle,
      `DailyReportFunction Errors alarm block must contain ${needle}`
    )
  }

  const failureReportAlarm = alarmBlockFor('ContactFailureReportFunction')
  assert.ok(
    failureReportAlarm,
    'expected a CloudWatch::Alarm block dimensioned on Value: !Ref ContactFailureReportFunction'
  )
  for (const needle of [
    /Namespace:\s*AWS\/Lambda/,
    /MetricName:\s*Errors/,
    /Threshold:\s*1\b/,
    /ContactAlarmTopic/
  ]) {
    assert.match(
      failureReportAlarm,
      needle,
      `ContactFailureReportFunction Errors alarm block must contain ${needle}`
    )
  }

  // --- S23 (INFRA-4 DR): PITR + Retain policies on the durable DynamoDB tables ---
  const pitrCount = (template.match(/PointInTimeRecoveryEnabled:\s*true/g) || []).length
  assert.ok(
    pitrCount >= 2,
    `expected PointInTimeRecoveryEnabled: true on the contact + chat-transcripts tables, found ${pitrCount}`
  )
  const retainDeletion = (template.match(/DeletionPolicy:\s*Retain/g) || []).length
  const retainReplace = (template.match(/UpdateReplacePolicy:\s*Retain/g) || []).length
  assert.ok(
    retainDeletion >= 2,
    `expected DeletionPolicy: Retain on the durable tables, found ${retainDeletion}`
  )
  assert.ok(
    retainReplace >= 2,
    `expected UpdateReplacePolicy: Retain on the durable tables, found ${retainReplace}`
  )

  // --- S24 (INFRA-3): the two scheduled crons must be staggered, not co-firing ---
  // Asserting the strings exist anywhere would pass even if the schedules were SWAPPED.
  // Split the resource map into per-function blocks and assert each cron lives inside
  // the block of the function it must drive, so a swap (failure-report at 12:00, daily
  // report at 11:30) fails the test.
  const functionBlockFor = name =>
    template.split(/^  (?=\w+:\n {4}Type:)/m).find(b => b.startsWith(`${name}:`))

  const dailyReportFn = functionBlockFor('DailyReportFunction')
  assert.ok(dailyReportFn, 'expected a DailyReportFunction resource block')
  assert.match(
    dailyReportFn,
    /Schedule:\s*cron\(0 12 \* \* \? \*\)/,
    'the DailyReportFunction block must schedule cron(0 12 * * ? *)'
  )

  const failureReportFn = functionBlockFor('ContactFailureReportFunction')
  assert.ok(failureReportFn, 'expected a ContactFailureReportFunction resource block')
  assert.match(
    failureReportFn,
    /Schedule:\s*cron\(30 11 \* \* \? \*\)/,
    'the ContactFailureReportFunction block must schedule the staggered cron(30 11 * * ? *)'
  )
})

test('templates declare + wire the IpHashPepper and SmokeProbeKey secrets (ADR-0008 + ADR-0009 deploy gap)', () => {
  // --- IpHashPepper (ADR-0008 SEC-2): a NoEcho param, mirroring AdminApiKey, injected
  // as IP_HASH_PEPPER so the IP-hashing functions key their HMAC at runtime. Without
  // the env wiring the deployed code hashes with an empty key (degraded, never keyed). ---
  assert.match(
    template,
    /IpHashPepper:\s*\n\s*Type:\s*String\s*\n\s*NoEcho:\s*true/,
    'expected a NoEcho IpHashPepper parameter in aws/template.yaml (mirroring AdminApiKey)'
  )
  assert.match(
    template,
    /IP_HASH_PEPPER:\s*!Ref IpHashPepper/,
    'expected IP_HASH_PEPPER: !Ref IpHashPepper wired into a function Environment'
  )

  // --- SmokeProbeKey (ADR-0009 S18 / FE-2): a probe-scoped NoEcho secret, distinct
  // from AdminApiKey, injected as SMOKE_PROBE_KEY so the daily-report Lambda can
  // authenticate the deep Live probe with x-smoke-key. ---
  assert.match(
    template,
    /SmokeProbeKey:\s*\n\s*Type:\s*String\s*\n\s*NoEcho:\s*true/,
    'expected a NoEcho SmokeProbeKey parameter in aws/template.yaml'
  )
  assert.match(
    template,
    /SMOKE_PROBE_KEY:\s*!Ref SmokeProbeKey/,
    'expected SMOKE_PROBE_KEY: !Ref SmokeProbeKey wired into a function Environment'
  )

  // --- chat-template.yaml: the chat container must read the SAME SMOKE_PROBE_KEY so
  // its /api/chat/smoke endpoint validates the probe credential the report Lambda sends. ---
  assert.match(
    chatTemplate,
    /SMOKE_PROBE_KEY:\s*!Ref \w+/,
    'expected SMOKE_PROBE_KEY wired into the chat container Environment in aws/chat-template.yaml'
  )

  // --- chat-express-template.yaml is the STAGING chat path (ECS Express); it must ALSO
  // declare a SmokeProbeKey param and wire SMOKE_PROBE_KEY into the container, or the
  // staging deep probe 401s even though the daily-report Lambda sends the key. ---
  assert.match(
    chatExpressTemplate,
    /SmokeProbeKey:\s*\n\s*Type:\s*String\s*\n\s*NoEcho:\s*true/,
    'expected a NoEcho SmokeProbeKey parameter in aws/chat-express-template.yaml'
  )
  assert.match(
    chatExpressTemplate,
    /SMOKE_PROBE_KEY,\s*Value:\s*!Ref SmokeProbeKey/,
    'expected SMOKE_PROBE_KEY wired into the chat-express container Environment'
  )
})
