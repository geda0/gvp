import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventsHandler } from '../aws/src/events-ingress-core.js'

function batchEvent(body) {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000', 'user-agent': 'test-agent' },
    body: JSON.stringify(body)
  }
}

const okEnv = { SITE_EVENTS_TABLE: 'site-events' }

test('a valid event batch is persisted and returns an accepted count', async () => {
  let persisted = null
  const handler = createEventsHandler({
    persistEvents: async (rows) => {
      persisted = rows
    },
    env: okEnv
  })

  const response = await handler(
    batchEvent({
      sessionId: 'sess-1',
      events: [
        { event: 'page_view', params: { section: 'home' } },
        { event: 'section_navigation', params: { section: 'portfolio' } }
      ]
    })
  )
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 202, 'event ingestion is fire-and-forget — 202 Accepted')
  assert.equal(body.accepted, 2)
  assert.ok(Array.isArray(persisted) && persisted.length === 2, 'both events must be written')
  assert.ok(persisted.every((r) => r.listPk === 'EVENT'), 'each row is an EVENT row')
})

test('the 202 body reports honest counts when some rows are dropped', async () => {
  let persisted = null
  const handler = createEventsHandler({
    persistEvents: async (rows) => {
      persisted = rows
    },
    env: okEnv
  })

  const response = await handler(
    batchEvent({
      sessionId: 'sess-drop',
      events: [
        { event: 'page_view' },
        { event: '' }, // dropped — no event name
        { params: { x: 1 } }, // dropped — no event name
        { event: 'theme_change' }
      ]
    })
  )
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 202)
  assert.equal(body.received, 4, 'received must report the raw count the client sent')
  assert.equal(body.persisted, 2, 'persisted must report only the rows actually written')
  assert.equal(body.dropped, 2, 'dropped must surface validation/over-cap losses, not hide them')
  assert.ok(Array.isArray(persisted) && persisted.length === 2, 'only the two valid rows are written')
})

test('an empty batch is a no-op success and never touches the store', async () => {
  let persistCalled = false
  const handler = createEventsHandler({
    persistEvents: async () => {
      persistCalled = true
    },
    env: okEnv
  })

  const response = await handler(batchEvent({ sessionId: 's', events: [] }))
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 202)
  assert.equal(body.accepted, 0)
  assert.equal(persistCalled, false, 'no rows means no write')
})

test('OPTIONS preflight returns 204 with a CORS origin and no IO', async () => {
  let persistCalled = false
  const handler = createEventsHandler({
    persistEvents: async () => {
      persistCalled = true
    },
    env: okEnv
  })
  const response = await handler({
    requestContext: { http: { method: 'OPTIONS' } },
    headers: { origin: 'http://localhost:8000' }
  })
  assert.equal(response.statusCode, 204)
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'http://localhost:8000')
  assert.equal(persistCalled, false)
})

test('non-POST is refused with 405 and no IO', async () => {
  let persistCalled = false
  const handler = createEventsHandler({
    persistEvents: async () => {
      persistCalled = true
    },
    env: okEnv
  })
  const response = await handler({
    requestContext: { http: { method: 'GET' } },
    headers: { origin: 'http://localhost:8000' }
  })
  assert.equal(response.statusCode, 405)
  assert.equal(persistCalled, false)
})

test('an oversized body is rejected before JSON.parse, with no IO', async () => {
  let persistCalled = false
  let parsed = false
  const handler = createEventsHandler({
    persistEvents: async () => {
      persistCalled = true
    },
    env: okEnv
  })
  // A ~70KB body exceeds the ~64KB events cap. If the guard runs BEFORE JSON.parse,
  // we never even need valid JSON — a giant non-JSON blob is refused outright.
  const giant = 'x'.repeat(70 * 1024)
  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000' },
    body: giant,
    get isBase64Encoded() {
      parsed = true
      return false
    }
  })
  assert.equal(response.statusCode, 413, 'an over-cap body is refused with 413 (Payload Too Large)')
  assert.equal(persistCalled, false, 'an over-cap request never reaches the store')
  assert.equal(parsed, false, 'the guard short-circuits before the body is ever decoded/parsed')
})

test('a normal <=40-event batch is unaffected by the size guard', async () => {
  let persisted = null
  const handler = createEventsHandler({
    persistEvents: async (rows) => {
      persisted = rows
    },
    env: okEnv
  })
  const events = Array.from({ length: 40 }, (_, i) => ({ event: `e${i}`, params: { i } }))
  const response = await handler(batchEvent({ sessionId: 's', events }))
  assert.equal(response.statusCode, 202, 'a normal batch is well under the size cap')
  assert.ok(Array.isArray(persisted) && persisted.length > 0, 'a normal batch still persists')
})

test('malformed JSON returns 400 without IO', async () => {
  let persistCalled = false
  const handler = createEventsHandler({
    persistEvents: async () => {
      persistCalled = true
    },
    env: okEnv
  })
  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'http://localhost:8000' },
    body: '{ not json'
  })
  assert.equal(response.statusCode, 400)
  assert.equal(persistCalled, false)
})

test('unconfigured table returns 500 without IO', async () => {
  let persistCalled = false
  const handler = createEventsHandler({
    persistEvents: async () => {
      persistCalled = true
    },
    env: {}
  })
  const response = await handler(batchEvent({ sessionId: 's', events: [{ event: 'page_view' }] }))
  assert.equal(response.statusCode, 500)
  assert.equal(persistCalled, false)
})

test('a persist failure never throws and never reports false success', async () => {
  const handler = createEventsHandler({
    persistEvents: async () => {
      throw new Error('ddb down')
    },
    env: okEnv
  })
  const response = await handler(batchEvent({ sessionId: 's', events: [{ event: 'page_view' }] }))
  assert.equal(response.statusCode, 500)
  const body = JSON.parse(response.body)
  assert.ok(body.error, 'a 500 carries an error message')
})
