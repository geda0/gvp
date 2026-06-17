import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEventRecord,
  normalizeEventBatch,
  utcDayBounds
} from '../aws/src/common/events-shared.js'

test('buildEventRecord normalizes a single interaction into a durable EVENT row', () => {
  const record = buildEventRecord(
    {
      event: 'project_interaction',
      sessionId: 'sess-abc',
      params: { interaction_type: 'open_details', project_id: 'gvp' },
      page: '/portfolio',
      section: 'portfolio'
    },
    { 'user-agent': 'test-agent', 'x-forwarded-for': '203.0.113.7' }
  )

  // Identity + GSI partitioning mirror the contact/chat convention.
  assert.equal(record.listPk, 'EVENT', 'every event row must carry listPk EVENT for the byCreatedAt GSI')
  assert.ok(record.id, 'event row needs a unique id')
  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'createdAt must be an ISO timestamp')

  assert.equal(record.event, 'project_interaction')
  assert.equal(record.sessionId, 'sess-abc')
  assert.equal(record.page, '/portfolio')
  assert.equal(record.section, 'portfolio')
  assert.deepEqual(record.params, { interaction_type: 'open_details', project_id: 'gvp' })
  assert.equal(record.userAgent, 'test-agent')
})

test('buildEventRecord hashes the client IP and never stores it raw', () => {
  const ip = '198.51.100.23'
  const record = buildEventRecord(
    { event: 'page_view', sessionId: 's1' },
    { 'x-forwarded-for': `${ip}, 70.0.0.1` }
  )
  assert.ok(record.ipHash, 'a client IP must produce a non-empty hash')
  assert.notEqual(record.ipHash, ip, 'the raw IP must never be stored')
  assert.doesNotMatch(JSON.stringify(record), /198\.51\.100\.23/, 'no raw IP anywhere in the row')
  // Same IP hashes stably; a different IP hashes differently.
  const again = buildEventRecord({ event: 'page_view', sessionId: 's2' }, { 'x-forwarded-for': ip })
  assert.equal(record.ipHash, again.ipHash, 'identical IPs hash to the same value')
})

test('buildEventRecord carries a TTL so raw events self-expire', () => {
  const record = buildEventRecord({ event: 'page_view', sessionId: 's1' }, {})
  assert.equal(typeof record.ttl, 'number', 'ttl must be a numeric epoch-seconds attribute for DynamoDB TTL')
  const nowSec = Math.floor(Date.now() / 1000)
  assert.ok(record.ttl > nowSec, 'ttl must be in the future')
})

test('buildEventRecord preserves a numeric client ts for faithful per-session ordering', () => {
  const withTs = buildEventRecord({ event: 'hero_click', sessionId: 's1', ts: 1781000000123 }, {})
  assert.equal(withTs.ts, 1781000000123, 'a numeric client ts is stored so the session timeline orders intra-batch events')
  const noTs = buildEventRecord({ event: 'hero_click', sessionId: 's1' }, {})
  assert.equal(noTs.ts, undefined, 'a missing ts is omitted, never stored as NaN')
  const badTs = buildEventRecord({ event: 'x', sessionId: 's1', ts: 'nope' }, {})
  assert.equal(badTs.ts, undefined, 'a non-numeric ts is rejected')
})

test('normalizeEventBatch keeps only well-formed events and clamps an oversized batch', () => {
  const raw = {
    sessionId: 'sess-top',
    events: [
      { event: 'page_view', params: { section: 'home' } },
      { event: '', params: {} }, // dropped — no event name
      { params: { x: 1 } }, // dropped — no event name
      { event: 'theme_change', params: { theme: 'garden' } }
    ]
  }
  const out = normalizeEventBatch(raw, { 'user-agent': 'ua' })
  assert.equal(out.length, 2, 'malformed events (missing name) are discarded')
  assert.equal(out[0].event, 'page_view')
  assert.equal(out[1].event, 'theme_change')
  // Batch-level sessionId is inherited when a child event omits its own.
  assert.equal(out[0].sessionId, 'sess-top')
})

test('normalizeEventBatch enforces a hard per-request cap', () => {
  const events = Array.from({ length: 500 }, (_, i) => ({ event: `e${i}` }))
  const out = normalizeEventBatch({ sessionId: 's', events }, {})
  assert.ok(out.length <= 100, 'a single request must not be able to write an unbounded number of rows')
})

test('utcDayBounds returns the inclusive ISO start and exclusive next-day start for a UTC day', () => {
  const { startIso, endIso } = utcDayBounds('2026-06-15')
  assert.equal(startIso, '2026-06-15T00:00:00.000Z')
  assert.equal(endIso, '2026-06-16T00:00:00.000Z')
})
