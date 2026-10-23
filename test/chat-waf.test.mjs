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
