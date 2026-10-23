// M7 (ADR-0020 amendment) — visitor-side alerts. /api/events is public and anonymous, so
// the classifier is an ALLOWLIST over (event, discriminator) and the Tier-1 line it builds
// contains only constants from that allowlist plus an integer status: nothing a visitor
// typed can reach the log line. Priority is static per alert type (ADR-0020: one type =
// one priority); conditions that are the visitor's own doing (mic denied, form invalid,
// insecure browser) are not alerts at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySiteAlert, siteAlertLines, SITE_ALERT_PREFIX } from '../aws/src/common/site-alerts-core.js'

const row = (event, params = {}) => ({ event, params, sessionId: 's-1', ipHash: 'h' })

test('server-side contact failures are P1; the visitor\'s own validation error is not an alert', () => {
  assert.deepEqual(classifySiteAlert(row('contact_submit_error', { code: 502 })), { type: 'contact_submit_error', prio: 'P1', detail: 'code=502' })
  assert.deepEqual(classifySiteAlert(row('contact_submit_error', { reason: 'network' })), { type: 'contact_submit_error', prio: 'P1', detail: 'reason=network' })
  assert.deepEqual(classifySiteAlert(row('contact_submit_error', { reason: 'unexpected_reply' })), { type: 'contact_submit_error', prio: 'P1', detail: 'reason=unexpected_reply' })
  assert.equal(classifySiteAlert(row('contact_submit_error', { reason: 'validation' })), null)
  assert.equal(classifySiteAlert(row('contact_submit_error', { code: 429 })), null)
})

test('voice that failed to start is P1; a denied microphone is the visitor\'s choice', () => {
  for (const phase of ['start', 'websocket', 'ws_closed_before_ready']) {
    assert.deepEqual(classifySiteAlert(row('chat_live_error', { phase, message: 'x' })), { type: 'chat_live_error', prio: 'P1', detail: `phase=${phase}` })
  }
  assert.equal(classifySiteAlert(row('chat_live_error', { phase: 'attach_mic' })), null)
})

test('a voice host the page cannot reach is P2; an insecure browser is not an alert', () => {
  assert.deepEqual(classifySiteAlert(row('chat_live_blocked', { reason: 'voice_host_endpoint' })), { type: 'chat_live_blocked', prio: 'P2', detail: 'reason=voice_host_endpoint' })
  assert.equal(classifySiteAlert(row('chat_live_blocked', { reason: 'insecure_or_no_mediadevices' })), null)
})

test('unknown events and forged discriminators are not alerts', () => {
  assert.equal(classifySiteAlert(row('page_view')), null)
  assert.equal(classifySiteAlert(row('chat_live_error', { phase: 'start\nCHAT_ALERT event=fake' })), null)
  assert.equal(classifySiteAlert(row('contact_submit_error', { code: '502' })), null)
  assert.equal(classifySiteAlert(row('contact_submit_error', { code: 502.5 })), null)
  assert.equal(classifySiteAlert(null), null)
})

test('siteAlertLines builds one stably-prefixed line per alerting row, with env and priority', () => {
  const lines = siteAlertLines(
    [row('page_view'), row('contact_submit_error', { code: 503 }), row('chat_live_blocked', { reason: 'voice_host_endpoint' })],
    'page-staging'
  )
  assert.equal(SITE_ALERT_PREFIX, 'SITE_ALERT event=')
  assert.deepEqual(lines, [
    'SITE_ALERT event=contact_submit_error prio=P1 env=page-staging code=503',
    'SITE_ALERT event=chat_live_blocked prio=P2 env=page-staging reason=voice_host_endpoint'
  ])
})

test('the env label is sanitized to a stack-name shape, defaulting to unknown', () => {
  assert.deepEqual(siteAlertLines([row('contact_submit_error', { code: 500 })], ''), ['SITE_ALERT event=contact_submit_error prio=P1 env=unknown code=500'])
  assert.deepEqual(siteAlertLines([row('contact_submit_error', { code: 500 })], 'page staging\nx'), ['SITE_ALERT event=contact_submit_error prio=P1 env=unknown code=500'])
})
