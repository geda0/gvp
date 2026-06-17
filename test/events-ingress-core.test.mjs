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
