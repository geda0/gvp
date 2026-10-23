// M8 item 2 (ADR-0021 D2) — ADR-0022 §15.3's request-rate ceiling: a WAF rate-based rule,
// 300 requests / 5 min / IP, on the chat CloudFront distribution. Required for prod (M-4 GO
// list); optional on stage. A CloudFront web ACL must be created in us-east-1 with
// Scope CLOUDFRONT, so it is its own stack whose ARN the us-east-2 CDN stack takes as a
// parameter (empty = no ACL, the pre-M8 shape).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('chat-waf-template.yaml: CLOUDFRONT-scope web ACL, default allow, one 300/5min/IP block rule', () => {
  const t = read('aws/chat-waf-template.yaml')
  assert.match(t, /Type:\s*AWS::WAFv2::WebACL/)
  assert.match(t, /Scope:\s*CLOUDFRONT/)
  assert.match(t, /DefaultAction:\s*\n\s+Allow:\s*\{\}/)
  assert.match(t, /RateBasedStatement:\s*\n(?:\s+\w+:.*\n)*?\s+Limit:\s*300\b/)
  assert.match(t, /EvaluationWindowSec:\s*300\b/)
  assert.match(t, /AggregateKeyType:\s*IP\b/)
  assert.match(t, /Action:\s*\n\s+Block:\s*\{\}/)
  assert.match(t, /Outputs:[\s\S]*WebAclArn:[\s\S]*!GetAtt\s+\w+\.Arn/)
})

test('the CDN distribution attaches the web ACL only when WebAclArn is given', () => {
  const t = read('aws/chat-stream-cdn-template.yaml')
  assert.match(t, /^  WebAclArn:\s*\n\s+Type:\s*String\s*\n\s+Default:\s*''/m)
  assert.match(t, /HasWebAcl:\s*!Not \[!Equals \[!Ref WebAclArn, ''\]\]/)
  assert.match(t, /WebACLId:\s*!If \[HasWebAcl, !Ref WebAclArn, !Ref 'AWS::NoValue'\]/)
})

test('the deploy script builds the WAF stack in us-east-1 (on by default for prod) and hands its ARN to the CDN stack', () => {
  const s = read('scripts/integrate-and-deploy.sh')
  assert.match(s, /CHAT_STREAM_WAF="\$\{CHAT_STREAM_WAF:-\$\( *\[\[ "\$\{DEPLOY_ENV\}" == prod \]\] && echo 1 \|\| echo 0 *\)\}"/)
  const waf = s.search(/--template-file "\$\{AWS_DIR\}\/chat-waf-template\.yaml"/)
  const cdn = s.search(/--template-file "\$\{AWS_DIR\}\/chat-stream-cdn-template\.yaml"/)
  assert.ok(waf > -1, 'no deploy of chat-waf-template.yaml')
  assert.ok(cdn > waf, 'the WAF stack must deploy before the CDN stack that references it')
  assert.match(s.slice(waf - 400, waf + 400), /--region us-east-1/)
  assert.match(s, /"WebAclArn=\$\{CHAT_STREAM_WEB_ACL_ARN:-\}"/)
})

// Critic (M8): a prod stream deploy with no alarm email silently creates NO §15.3 alarms and NO
// budgets (they share HasChatAlertAlarm), and a WAF ARN lookup that yields "None"/empty would
// only fail later inside the CDN stack. Both must be loud at the step that causes them.
test('the deploy script fails loudly on a bad WAF ARN and warns when prod has no alarm email', () => {
  const s = read('scripts/integrate-and-deploy.sh')
  assert.match(s, /\[\[ "\$\{CHAT_STREAM_WEB_ACL_ARN\}" == arn:aws:wafv2:\* \]\] \|\|/)
  assert.match(s, /if \[\[ "\$\{DEPLOY_ENV\}" == prod && -z "\$\{CHAT_STREAM_ALARM_EMAIL\}" \]\]/)
})

// Prod deploy 2026-10-23 failed: WAFv2 rejects a Description outside
// ^[\w+=:#@/\-,\.][\w+=:#@/\-,\.\s]+[\w+=:#@/\-,\.]$ — the '§' and parentheses killed it.
test('every WAF Description satisfies WAFv2\'s character pattern', () => {
  const t = read('aws/chat-waf-template.yaml')
  const res = t.split(/^Resources:\s*$/m)[1].split(/^Outputs:\s*$/m)[0] // only what reaches the WAF API
  const descs = [...res.matchAll(/^\s+Description:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''))
  assert.ok(descs.length >= 1)
  for (const d of descs) assert.match(d, /^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/, d)
})

// The same run warned it would deploy the CDN in GATE MODE (no CHAT_SAM_STACK_NAME_* in CI),
// i.e. strip the API Gateway throttle off every non-stream route. Never silently: keep the
// CDN stack's existing DefaultOriginDomainName when nothing better is known.
test('the deploy script keeps the CDN\'s existing default origin instead of falling into gate mode', () => {
  const s = read('scripts/integrate-and-deploy.sh')
  const keep = s.search(/ParameterKey=='DefaultOriginDomainName'/)
  const gate = s.search(/deploying \$\{CHAT_STREAM_CDN_STACK\} in gate mode/)
  assert.ok(keep > -1, 'no read of the existing DefaultOriginDomainName')
  assert.ok(keep < gate, 'the existing origin must be tried before the gate-mode fallback')
})

test('a WAF stack left in ROLLBACK_COMPLETE is deleted before the retry (CFN cannot update it)', () => {
  const s = read('scripts/integrate-and-deploy.sh')
  const waf = s.slice(s.indexOf('CHAT_WAF_STACK='), s.indexOf('CHAT_STREAM_CDN_PO=('))
  assert.match(waf, /ROLLBACK_COMPLETE[\s\S]{0,400}delete-stack[\s\S]{0,200}--region us-east-1/)
})
