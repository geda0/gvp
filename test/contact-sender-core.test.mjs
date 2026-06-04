import test from 'node:test'
import assert from 'node:assert/strict'
import { createSenderHandler } from '../aws/src/contact-sender-core.js'

// One SQS record carrying the id of a queued contact row awaiting delivery.
function queuedDeliveryEvent() {
  return {
    Records: [{ body: JSON.stringify({ id: 'm1' }) }]
  }
}

test('sender sends then marks the row sent', async () => {
  // Arrange: a queued row, and fakes that record the observable effect order on a
  // shared array so we can prove send happened BEFORE the row was marked sent.
  const calls = []
  let markSentArgs = null
  const handler = createSenderHandler({
    store: {
      loadMessage: async () => ({
        id: 'm1',
        status: 'queued',
        attempts: 0,
        email: 'ada@example.com',
        subject: 'Hi',
        name: 'Ada',
        message: 'hello'
      }),
      markSending: async () => {},
      markSent: async (id, attempts, resendId) => {
        markSentArgs = { id, attempts, resendId }
        calls.push('markSent')
      },
      markFailed: async () => {
        calls.push('markFailed')
      }
    },
    sendEmail: async () => {
      calls.push('send')
      return { id: 'resend-1' }
    },
    env: {
      RESEND_API_KEY: 'rk_test',
      CONTACT_FROM_EMAIL: 'from@example.com',
      CONTACT_TO_EMAIL: 'to@example.com'
    }
  })

  // Act
  await handler(queuedDeliveryEvent())

  // Assert send-before-mark: the email was sent AND the row was marked sent, with
  // the send strictly ordered before the mark — we never record `sent` for a
  // message that wasn't actually delivered first.
  assert.ok(calls.includes('send'), 'the email must be sent')
  assert.ok(calls.includes('markSent'), 'the row must be marked sent')
  assert.ok(
    calls.indexOf('send') < calls.indexOf('markSent'),
    'the email must be sent BEFORE the row is marked sent'
  )

  // Assert the failure path is never taken on a successful delivery.
  assert.ok(!calls.includes('markFailed'), 'markFailed must not run on a successful send')

  // Assert proof-of-delivery is threaded through: the row is marked sent for this
  // id, carrying the resend id returned by the send.
  assert.equal(markSentArgs.id, 'm1', 'the queued row m1 must be the one marked sent')
  assert.equal(
    markSentArgs.resendId,
    'resend-1',
    'markSent must receive the delivered resend id as proof of delivery'
  )
})

test('sender marks failed and rethrows when send fails', async () => {
  // Arrange: a queued row whose delivery will fail. The fake sendEmail rejects
  // (Resend 500). We record collaborator touches and capture the markFailed args
  // so we can prove the failure path ran and the success path did not.
  const calls = []
  let markFailedArgs = null
  const handler = createSenderHandler({
    store: {
      loadMessage: async () => ({
        id: 'm1',
        status: 'queued',
        attempts: 0,
        email: 'ada@example.com',
        subject: 'Hi',
        name: 'Ada',
        message: 'hello'
      }),
      markSending: async () => {
        calls.push('markSending')
      },
      markSent: async () => {
        calls.push('markSent')
      },
      markFailed: async (id, attempts, errorMessage) => {
        markFailedArgs = { id, attempts, errorMessage }
        calls.push('markFailed')
      }
    },
    sendEmail: async () => {
      throw new Error('resend 500')
    },
    env: {
      RESEND_API_KEY: 'rk_test',
      CONTACT_FROM_EMAIL: 'from@example.com',
      CONTACT_TO_EMAIL: 'to@example.com'
    }
  })

  // Act + Assert: the handler must REJECT — re-throwing is what makes SQS redeliver
  // the message (retry -> eventually DLQ); a swallowed error would silently drop it.
  await assert.rejects(() => handler(queuedDeliveryEvent()))

  // Assert the row was marked FAILED for this id, carrying its attempt count and a
  // non-empty error message (we don't pin the exact wording).
  assert.ok(calls.includes('markFailed'), 'a failed send must mark the row failed')
  assert.equal(markFailedArgs.id, 'm1', 'the failed row m1 must be the one marked failed')
  assert.equal(markFailedArgs.attempts, 1, 'markFailed must carry the bumped attempt count')
  assert.equal(
    typeof markFailedArgs.errorMessage,
    'string',
    'markFailed must receive an error message string'
  )
  assert.ok(
    markFailedArgs.errorMessage.length > 0,
    'the recorded error message must be non-empty'
  )

  // Assert the row is NEVER marked sent on a failed delivery — we must not record
  // proof-of-delivery for a message that was never delivered.
  assert.ok(!calls.includes('markSent'), 'markSent must not run when the send fails')
})

test('sender skips already-sent or missing rows with no IO', async () => {
  // Arrange: a shared log records ANY collaborator touch beyond the load. For each
  // record the only thing allowed to happen is loadMessage; if the guard is correct
  // nothing else fires, so the log stays empty across both skip conditions.
  const calls = []
  const handler = createSenderHandler({
    store: {
      // Case A returns an already-`sent` row; Case B returns nothing (deleted row).
      loadMessage: async (id) => (id === 'm-sent' ? { id, status: 'sent', attempts: 1 } : null),
      markSending: async () => calls.push('markSending'),
      markSent: async () => calls.push('markSent'),
      markFailed: async () => calls.push('markFailed')
    },
    sendEmail: async () => calls.push('send'),
    env: {
      RESEND_API_KEY: 'rk_test',
      CONTACT_FROM_EMAIL: 'from@example.com',
      CONTACT_TO_EMAIL: 'to@example.com'
    }
  })

  // Act: redeliver BOTH a sent row (Case A) and a missing/deleted row (Case B).
  await handler({
    Records: [
      { body: JSON.stringify({ id: 'm-sent' }) },
      { body: JSON.stringify({ id: 'm-missing' }) }
    ]
  })

  // Assert a full NO-OP for both: safe SQS redelivery never re-sends a delivered
  // message nor touches a vanished one — no email, and no status transition at all.
  assert.deepEqual(
    calls,
    [],
    'an already-sent or missing row must be skipped: no sendEmail, no markSending/markSent/markFailed'
  )
})
