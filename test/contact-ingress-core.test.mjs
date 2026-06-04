import test from 'node:test'
import assert from 'node:assert/strict'
import { createIngressHandler } from '../aws/src/contact-ingress-core.js'

// A realistic, VALID contact POST: valid email + non-empty message, and an
// empty honeypot (`company`) so the normal persist+enqueue path runs.
function validPostEvent() {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000', 'user-agent': 'test-agent' },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      subject: 'Hello',
      message: 'I would like to get in touch.'
    })
  }
}

test('valid submission persists then enqueues before returning 200', async () => {
  // Arrange: inject fakes that record observable effect order on a shared array.
  const calls = []
  let enqueuedJob = null
  const handler = createIngressHandler({
    persistMessage: async () => {
      calls.push('persist')
    },
    enqueueDelivery: async (job) => {
      enqueuedJob = job
      calls.push('enqueue')
    },
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  // Act
  const response = await handler(validPostEvent())
  const body = JSON.parse(response.body)

  // Assert: the 200 reports the message persisted + queued, and carries an id.
  assert.equal(response.statusCode, 200)
  assert.equal(body.persisted, true)
  assert.equal(body.delivery, 'queued')
  assert.ok(body.id, 'response body must carry the message id')

  // Assert durability: BOTH the persist and the enqueue happened, persist FIRST.
  assert.deepEqual(calls, ['persist', 'enqueue'])

  // Assert the enqueued delivery job references the persisted message id.
  assert.equal(enqueuedJob.id, body.id)
})

test('honeypot company field is silently discarded with 200 and no IO', async () => {
  // Arrange: a bot fills the hidden `company` honeypot alongside otherwise-valid
  // fields. Inject fakes that record whether the persist/enqueue IO ever ran.
  let persistCalled = false
  let enqueueCalled = false
  const handler = createIngressHandler({
    persistMessage: async () => {
      persistCalled = true
    },
    enqueueDelivery: async () => {
      enqueueCalled = true
    },
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  const honeypotEvent = {
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000', 'user-agent': 'spam-bot' },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      subject: 'Hello',
      message: 'I would like to get in touch.',
      company: 'Acme Corp'
    })
  }

  // Act
  const response = await handler(honeypotEvent)

  // Assert: the bot sees apparent success...
  assert.equal(response.statusCode, 200)

  // ...but nothing is stored or queued, so no delivery email is ever generated.
  assert.equal(persistCalled, false, 'spam must never be persisted to the store')
  assert.equal(enqueueCalled, false, 'spam must never be enqueued for delivery')
})

test('honeypot 200 body is a hollow decoy with no id', async () => {
  // Arrange: a bot fills the hidden `company` honeypot. The decoy must MIMIC
  // the real success body (persisted/queued) yet carry no message id, since
  // nothing was actually stored. Pin the body SHAPE so a later refactor can't
  // "tidy" the decoy into emitting an id and silently weaken the anti-spam tell.
  const handler = createIngressHandler({
    persistMessage: async () => {},
    enqueueDelivery: async () => {},
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  const honeypotEvent = {
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000', 'user-agent': 'spam-bot' },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      subject: 'Hello',
      message: 'I would like to get in touch.',
      company: 'Acme Corp'
    })
  }

  // Act
  const response = await handler(honeypotEvent)
  const body = JSON.parse(response.body)

  // Assert: looks like the real success body to the bot...
  assert.equal(response.statusCode, 200)
  assert.equal(body.persisted, true)
  assert.equal(body.delivery, 'queued')

  // ...but carries NO message id — the tell that nothing was ever stored.
  assert.equal(body.id, undefined, 'the honeypot decoy must not emit a message id')
})

test('persist failure returns 500 and does not enqueue', async () => {
  // Arrange: persist rejects (DDB down); enqueue records whether it ever ran.
  let enqueueCalled = false
  const handler = createIngressHandler({
    persistMessage: async () => {
      throw new Error('ddb unavailable')
    },
    enqueueDelivery: async () => {
      enqueueCalled = true
    },
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  // Act: the handler RESOLVES a response (it must not throw).
  const response = await handler(validPostEvent())
  const body = JSON.parse(response.body)

  // Assert: a 500 with an error body, never a false success.
  assert.equal(response.statusCode, 500)
  assert.equal(typeof body.error, 'string')
  assert.ok(body.error.length > 0, 'a 500 must carry a non-empty error message')

  // Assert durability: no orphan delivery job for a message that was never stored.
  assert.equal(enqueueCalled, false)
})

test('malformed JSON body returns 400 without IO', async () => {
  // Arrange: a request arrives with a body that is NOT parseable JSON. Inject
  // fakes that record whether the persist/enqueue IO ever ran.
  let persistCalled = false
  let enqueueCalled = false
  const handler = createIngressHandler({
    persistMessage: async () => {
      persistCalled = true
    },
    enqueueDelivery: async () => {
      enqueueCalled = true
    },
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  const malformedEvent = {
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000', 'user-agent': 'test-agent' },
    body: '{ not valid json'
  }

  // Act: the handler RESOLVES a response (it must not throw on a bad body).
  const response = await handler(malformedEvent)
  const body = JSON.parse(response.body)

  // Assert: a 400 with the exact, pinned error contract for malformed input.
  assert.equal(response.statusCode, 400)
  assert.equal(body.error, 'Invalid JSON')

  // Assert durability: a request that never parsed must touch neither store nor queue.
  assert.equal(persistCalled, false, 'a malformed body must never be persisted')
  assert.equal(enqueueCalled, false, 'a malformed body must never be enqueued')
})

test('invalid payload returns 400 without IO', async () => {
  // Arrange: a request that PARSES as JSON and leaves the honeypot empty, but
  // fails content validation — here an EMPTY message (valid email otherwise).
  // Inject fakes that record whether the persist/enqueue IO ever ran.
  let persistCalled = false
  let enqueueCalled = false
  const handler = createIngressHandler({
    persistMessage: async () => {
      persistCalled = true
    },
    enqueueDelivery: async () => {
      enqueueCalled = true
    },
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  const invalidEvent = {
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000', 'user-agent': 'test-agent' },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      subject: 'Hello',
      message: '',
      company: ''
    })
  }

  // Act
  const response = await handler(invalidEvent)
  const body = JSON.parse(response.body)

  // Assert: a 400 whose body reports the validation reason.
  assert.equal(response.statusCode, 400)
  assert.equal(typeof body.error, 'string')
  assert.ok(body.error.length > 0, 'a 400 must carry a non-empty validation reason')

  // Assert durability: content that failed validation touches neither store nor queue.
  assert.equal(persistCalled, false, 'invalid content must never be persisted')
  assert.equal(enqueueCalled, false, 'invalid content must never be enqueued')
})

test('missing config returns 500 without IO', async () => {
  // Arrange: a VALID submission (parses, empty honeypot, passes validation) but
  // the service is NOT configured — the injected env lacks the required table and
  // queue vars. Inject fakes that record whether the persist/enqueue IO ever ran.
  let persistCalled = false
  let enqueueCalled = false
  const handler = createIngressHandler({
    persistMessage: async () => {
      persistCalled = true
    },
    enqueueDelivery: async () => {
      enqueueCalled = true
    },
    env: {}
  })

  // Act
  const response = await handler(validPostEvent())
  const body = JSON.parse(response.body)

  // Assert: a 500 with a non-empty error body — never a false success.
  assert.equal(response.statusCode, 500)
  assert.equal(typeof body.error, 'string')
  assert.ok(body.error.length > 0, 'a 500 must carry a non-empty error message')

  // Assert durability: when unconfigured we never attempt the store or the queue.
  assert.equal(persistCalled, false, 'an unconfigured service must never persist')
  assert.equal(enqueueCalled, false, 'an unconfigured service must never enqueue')
})

test('enqueue failure after persist returns 500', async () => {
  // Arrange: persist SUCCEEDS (records that it ran), but the enqueue REJECTS
  // (SQS down). The caller must never see a false 200 for a message that was
  // stored but never queued for delivery.
  let persistRan = false
  const handler = createIngressHandler({
    persistMessage: async () => {
      persistRan = true
    },
    enqueueDelivery: async () => {
      throw new Error('sqs unavailable')
    },
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  // Act: the handler RESOLVES a response (it must not throw).
  const response = await handler(validPostEvent())
  const body = JSON.parse(response.body)

  // Assert: the persist happened first, before the enqueue was attempted.
  assert.equal(persistRan, true, 'persist must run before the enqueue is attempted')

  // Assert: a 500 with an error body, never a false success.
  assert.equal(response.statusCode, 500)
  assert.equal(typeof body.error, 'string')
  assert.ok(body.error.length > 0, 'a 500 must carry a non-empty error message')
})

test('method gate routes OPTIONS to preflight and non-POST to 405 without IO', async () => {
  // Arrange: a shared call log records whether the persist/enqueue IO ever ran.
  // The same handler instance serves both method cases; the gate must fire
  // BEFORE any body parsing or store/queue work.
  const calls = []
  const handler = createIngressHandler({
    persistMessage: async () => {
      calls.push('persist')
    },
    enqueueDelivery: async () => {
      calls.push('enqueue')
    },
    env: {
      CONTACT_MESSAGES_TABLE: 'contact-messages',
      CONTACT_DELIVERY_QUEUE_URL: 'https://sqs.local/delivery'
    }
  })

  // Act: a CORS preflight — OPTIONS, no parseable body.
  const optionsEvent = {
    requestContext: { http: { method: 'OPTIONS' } },
    headers: { origin: 'http://localhost:8000' }
  }
  const optionsResponse = await handler(optionsEvent)

  // Assert: the exact preflight contract — 204 with a CORS allow-origin header.
  assert.equal(optionsResponse.statusCode, 204)
  assert.equal(
    optionsResponse.headers['Access-Control-Allow-Origin'],
    'http://localhost:8000',
    'preflight must echo the allowed origin on Access-Control-Allow-Origin'
  )

  // Act: a non-POST method — GET, which must be refused outright.
  const getEvent = {
    requestContext: { http: { method: 'GET' } },
    headers: { origin: 'http://localhost:8000' }
  }
  const getResponse = await handler(getEvent)
  const getBody = JSON.parse(getResponse.body)

  // Assert: a 405 whose body reports the method is not allowed.
  assert.equal(getResponse.statusCode, 405)
  assert.equal(getBody.error, 'Method not allowed')

  // Assert durability: the method gate fired first — neither case touched the
  // store or the queue.
  assert.deepEqual(calls, [], 'a gated request must touch neither store nor queue')
})
