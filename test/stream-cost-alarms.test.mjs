// M8 item 2 (ADR-0021 D2) builds ADR-0022 §15.3's owed cost controls on the Lambda stream host.
// /api/chat reaches the RESPONSE_STREAM Function URL through CloudFront with no API Gateway
// throttle in front, so these alarms are the "someone is running up the bill" signal. The
// numbers are §15.3's, verbatim; the duration alarm is not redundant (90 s timeouts make a
// few long invocations bill like many short ones).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const tpl = readFileSync(new URL('../aws/chat-stream-template.yaml', import.meta.url), 'utf8')

function resources(text) {
  const body = text.split(/^Resources:\s*$/m)[1].split(/^Outputs:\s*$/m)[0]
  const out = new Map()
  for (const chunk of body.split(/^(?=  [A-Za-z0-9]+:\s*$)/m)) {
    const m = chunk.match(/^  ([A-Za-z0-9]+):\s*$/m)
    if (m) out.set(m[1], chunk)
  }
  return out
}
const field = (body, key) => (body.match(new RegExp(`^\\s+(?:- )?${key}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^['"]|['"]$/g, '')

const REQUIRED = [
  { metric: 'Invocations', period: 300, threshold: 2000 },
  { metric: 'Invocations', period: 3600, threshold: 20000 },
  { metric: 'Duration', period: 3600, threshold: 1800000 }
]

test('the stream function carries the three §15.3 cost alarms, wired to the alert topic', () => {
  const alarms = [...resources(tpl)].filter(([, b]) => /^    Type: AWS::CloudWatch::Alarm\s*$/m.test(b))
  const broken = []
  for (const want of REQUIRED) {
    const hit = alarms.find(([, b]) =>
      field(b, 'Namespace') === 'AWS/Lambda' &&
      field(b, 'MetricName') === want.metric &&
      Number(field(b, 'Period')) === want.period &&
      Number(field(b, 'Threshold')) === want.threshold
    )
    if (!hit) { broken.push(`no ${want.metric} ≥ ${want.threshold} / ${want.period}s alarm`); continue }
    const [id, b] = hit
    if (field(b, 'Statistic') !== 'Sum') broken.push(`${id}: Statistic must be Sum`)
    if (!/Name:\s*FunctionName\s*\n\s+Value:\s*!Ref ChatStreamFunction/.test(b)) broken.push(`${id}: must be dimensioned on ChatStreamFunction`)
    if (!/AlarmActions:\s*\n\s*- !Ref ChatStreamAlertTopic/.test(b)) broken.push(`${id}: must notify ChatStreamAlertTopic`)
    if (field(b, 'Condition') !== 'HasChatAlertAlarm') broken.push(`${id}: must share the topic's HasChatAlertAlarm condition`)
    if (!/\$\{StageName\}/.test(field(b, 'AlarmName') || '')) broken.push(`${id}: AlarmName must carry \${StageName}`)
  }
  assert.deepEqual(broken, [], broken.join('\n'))
})

// §15.3's two budgets. A budget is ACCOUNT-wide, so it is created once — by the prod stack —
// or stage and prod would each mint a copy and each email twice.
test('the prod stream stack (only) carries the $15 Lambda and $70 account budgets at 80% and 100% actual', () => {
  const res = resources(tpl)
  const conds = tpl.split(/^Conditions:\s*$/m)[1].split(/^Resources:\s*$/m)[0]
  const budgets = [...res].filter(([, b]) => /^    Type: AWS::Budgets::Budget\s*$/m.test(b))
  assert.equal(budgets.length, 2, `expected 2 budgets, found ${budgets.map(([id]) => id)}`)
  const amounts = budgets.map(([, b]) => Number((b.match(/Amount:\s*(\d+)/) || [])[1])).sort((a, b) => a - b)
  assert.deepEqual(amounts, [15, 70])
  for (const [id, b] of budgets) {
    const cond = field(b, 'Condition')
    assert.ok(cond, `${id} must be conditional`)
    const def = (conds.match(new RegExp(`^  ${cond}:([\\s\\S]*?)(?=^  \\w+:|$(?![\\s\\S]))`, 'm')) || [])[1] || ''
    assert.match(def, /StageName[\s\S]*prod|prod[\s\S]*StageName/, `${id}: condition ${cond} must require StageName = prod`)
    assert.match(b, /TimeUnit:\s*MONTHLY/)
    assert.match(b, /Unit:\s*USD/)
    for (const pct of [80, 100]) {
      assert.match(b, new RegExp(`NotificationType:\\s*ACTUAL[\\s\\S]*?Threshold:\\s*${pct}\\b`), `${id}: needs an ACTUAL ${pct}% notification`)
    }
    assert.match(b, /SubscriptionType:\s*EMAIL\s*\n\s+Address:\s*!Ref ChatAlertAlarmEmail/)
    if (Number((b.match(/Amount:\s*(\d+)/) || [])[1]) === 15) assert.match(b, /Service:\s*\n\s+- AWS Lambda/, 'the $15 budget is Lambda-scoped')
  }
})
