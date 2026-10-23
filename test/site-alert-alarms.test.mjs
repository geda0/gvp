// M7 (ADR-0020 amendment) — the SITE_ALERT line reaches a human only through
// log group -> metric filter -> alarm -> ContactAlarmTopic, the same Tier-2 shape the chat
// hosts use (ADR-0022 §29). An in-process send from a Lambda is not reliable delivery, so
// every link is checked, and the filter's quoted term is DERIVED from the emitter's prefix.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SITE_ALERT_PREFIX } from '../aws/src/common/site-alerts-core.js'

const tpl = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8')

// Top-level Resources only: a two-space-indented logical ID followed by its body.
function resources(text) {
  const body = text.split(/^Resources:\s*$/m)[1].split(/^Outputs:\s*$/m)[0]
  const out = new Map()
  for (const chunk of body.split(/^(?=  [A-Za-z0-9]+:\s*$)/m)) {
    const m = chunk.match(/^  ([A-Za-z0-9]+):\s*$/m)
    if (m) out.set(m[1], chunk)
  }
  return out
}
const ofType = (res, type) => [...res].filter(([, b]) => new RegExp(`^    Type: ${type}\\s*$`, 'm').test(b))
const field = (body, key) => (body.match(new RegExp(`^\\s+(?:- )?${key}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^['"]|['"]$/g, '')

test('events ingress logs to a stack-owned group carrying the env label', () => {
  const res = resources(tpl)
  const fn = res.get('EventsIngressFunction') || ''
  const [[groupId] = []] = ofType(res, 'AWS::Logs::LogGroup')
  assert.ok(groupId, 'a stack-owned AWS::Logs::LogGroup must exist (Lambda\'s implicit group cannot carry a filter until first invocation)')
  assert.match(fn, new RegExp(`LoggingConfig:[\\s\\S]*LogGroup:\\s*!Ref ${groupId}`), 'EventsIngressFunction must write to that group')
  assert.match(fn, /SITE_ENV:\s*!Ref AWS::StackName/, 'SITE_ENV names the stack (page vs page-staging)')
})

test('M7: P1 and P2 SITE_ALERT chains end at ContactAlarmTopic, per-stack metric names', () => {
  const res = resources(tpl)
  const quoted = `"${SITE_ALERT_PREFIX}"`
  const filters = ofType(res, 'AWS::Logs::MetricFilter')
  const alarms = ofType(res, 'AWS::CloudWatch::Alarm')
  const broken = []
  for (const [prio, test, maxPeriod] of [
    ['P1', p => p.includes(quoted) && p.includes('-"prio=P2"'), 300],
    ['P2', p => p.includes(quoted) && /(^|[^-])"prio=P2"/.test(p), 300]
  ]) {
    const f = filters.find(([, b]) => test(field(b, 'FilterPattern') || ''))
    if (!f) { broken.push(`no ${prio} SITE_ALERT filter`); continue }
    const name = field(f[1], 'MetricName')
    if (!/\$\{AWS::StackName\}/.test(name || '')) broken.push(`${prio} metric ${name} must carry \${AWS::StackName}`)
    const a = alarms.find(([, b]) => field(b, 'MetricName') === name && field(b, 'Namespace') === field(f[1], 'MetricNamespace'))
    if (!a) { broken.push(`no alarm on ${prio} metric ${name}`); continue }
    if (!(Number(field(a[1], 'Period')) <= maxPeriod)) broken.push(`${prio} alarm Period > ${maxPeriod}`)
    if (!/AlarmActions:\s*\n\s*- !Ref ContactAlarmTopic/.test(a[1])) broken.push(`${prio} alarm must notify ContactAlarmTopic`)
    if (!new RegExp(prio).test(field(a[1], 'AlarmName') || '')) broken.push(`${prio} AlarmName must say ${prio}`)
  }
  assert.deepEqual(broken, [], broken.join('\n'))
})

// Critic D2: /api/events is public, so ONE forged qualifying row per window re-arms the alarm.
// An ALARM->OK->ALARM cycle needs at least two periods, so the period bounds the forged-page
// rate: 300 s caps it near 6 emails/hour per chain, where 60 s allowed ~30. The chat-host P1
// alarms keep 60 s because only the app can write their lines.
test('the public-triggerable SITE_ALERT P1 alarm evaluates over at least 300 s', () => {
  const res = resources(tpl)
  const p1 = ofType(res, 'AWS::CloudWatch::Alarm').find(([, b]) => /SiteAlertLinesP1/.test(field(b, 'MetricName') || ''))
  assert.ok(p1, 'no SITE_ALERT P1 alarm')
  assert.ok(Number(field(p1[1], 'Period')) >= 300, `Period is ${field(p1[1], 'Period')}`)
})
