import test from 'node:test'
import assert from 'node:assert/strict'
import { sendViaResend } from '../aws/src/common/resend.js'

// Capture the single fetch call sendViaResend makes so we can inspect the headers
// it forwarded to the Resend API without hitting the network.
function stubFetch() {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'resend-1' })
    }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    }
  }
}

test('sendViaResend forwards a stable Idempotency-Key header when one is supplied', async () => {
  // Arrange: a date-derived idempotency key, as the daily-report send threads in so
  // a retry/double-fire for the same report day yields ONE delivered email.
  const stub = stubFetch()
  try {
    await sendViaResend({
      apiKey: 'rk_test',
      from: 'from@example.com',
      to: 'to@example.com',
      subject: '[Daily report] 2026-06-16',
      text: 'body',
      html: '<p>body</p>',
      idempotencyKey: 'daily-report-2026-06-16'
    })

    // Assert: exactly one request was issued, carrying the supplied key verbatim in
    // the Idempotency-Key header. Resend dedupes on this key, so the same key for
    // the same day collapses a retry to a single delivery.
    assert.equal(stub.calls.length, 1, 'exactly one Resend request must be issued')
    const { init } = stub.calls[0]
    assert.equal(
      init.headers['Idempotency-Key'],
      'daily-report-2026-06-16',
      'the supplied idempotency key must be forwarded as the Idempotency-Key header'
    )
  } finally {
    stub.restore()
  }
})

test('sendViaResend omits the Idempotency-Key header when none is supplied', async () => {
  // Arrange: the contact-sender path calls sendViaResend WITHOUT a key — each queued
  // message is a distinct delivery and must NOT be deduped against any other.
  const stub = stubFetch()
  try {
    await sendViaResend({
      apiKey: 'rk_test',
      from: 'from@example.com',
      to: 'to@example.com',
      subject: 'Hi',
      text: 'hello'
    })

    // Assert: no Idempotency-Key header leaks onto the default (contact-sender) path,
    // so behavior there is unchanged.
    assert.equal(stub.calls.length, 1, 'exactly one Resend request must be issued')
    const { init } = stub.calls[0]
    assert.ok(
      !('Idempotency-Key' in init.headers),
      'no Idempotency-Key header must be sent when no key is supplied'
    )
  } finally {
    stub.restore()
  }
})
