import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  buildEventRecord,
  normalizeEventBatch
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

// ADR-0008 SEC-2: the visitor ipHash must be KEYED end-to-end. buildEventRecord
// reads IP_HASH_PEPPER and passes it through, so record.ipHash is the HMAC of the
// client IP — and when the pepper is missing it FAILS SAFE to '' rather than the
// reversible unkeyed hash. We mutate process.env here, so save/restore the prior
// value to avoid leaking key state into other tests/files.
test('buildEventRecord keys the client IP with IP_HASH_PEPPER, never the raw or unkeyed hash', () => {
  const prevPepper = process.env.IP_HASH_PEPPER
  try {
    const ip = '198.51.100.23'
    const pepper = 'events-pepper'
    process.env.IP_HASH_PEPPER = pepper
    const expectedKeyed = crypto
      .createHmac('sha256', pepper)
      .update(ip)
      .digest('hex')
      .slice(0, 16)
    const legacyUnkeyed = crypto
      .createHash('sha256')
      .update(ip)
      .digest('hex')
      .slice(0, 16)

    const record = buildEventRecord(
      { event: 'page_view', sessionId: 's1' },
      { 'x-forwarded-for': `${ip}, 70.0.0.1` }
    )

    // The stored hash is the KEYED HMAC of the leftmost (real visitor) IP...
    assert.equal(record.ipHash, expectedKeyed, 'ipHash must be the keyed HMAC of the client IP')
    // ...which proves it is neither the raw IP nor the reversible unkeyed hash.
    assert.notEqual(record.ipHash, ip, 'the raw IP must never be stored')
    assert.notEqual(record.ipHash, legacyUnkeyed, 'ipHash must not be the reversible unkeyed hash')
    assert.doesNotMatch(JSON.stringify(record), /198\.51\.100\.23/, 'no raw IP anywhere in the row')
    // Same IP hashes stably under the same pepper.
    const again = buildEventRecord({ event: 'page_view', sessionId: 's2' }, { 'x-forwarded-for': ip })
    assert.equal(record.ipHash, again.ipHash, 'identical IPs hash to the same value')
  } finally {
    if (prevPepper === undefined) delete process.env.IP_HASH_PEPPER
    else process.env.IP_HASH_PEPPER = prevPepper
  }
})

test('buildEventRecord fails safe to an empty ipHash when IP_HASH_PEPPER is unset', () => {
  const prevPepper = process.env.IP_HASH_PEPPER
  try {
    const ip = '198.51.100.23'
    delete process.env.IP_HASH_PEPPER
    const legacyUnkeyed = crypto
      .createHash('sha256')
      .update(ip)
      .digest('hex')
      .slice(0, 16)

    const record = buildEventRecord(
      { event: 'page_view', sessionId: 's1' },
      { 'x-forwarded-for': `${ip}, 70.0.0.1` }
    )

    // No key -> no hash. Fail safe to '' rather than the reversible unkeyed hash.
    assert.equal(record.ipHash, '', 'with no pepper ipHash must be omitted, never the unkeyed hash')
    assert.notEqual(record.ipHash, legacyUnkeyed, 'must not degrade to the reversible unkeyed hash')
    assert.doesNotMatch(JSON.stringify(record), /198\.51\.100\.23/, 'no raw IP anywhere in the row')
  } finally {
    if (prevPepper === undefined) delete process.env.IP_HASH_PEPPER
    else process.env.IP_HASH_PEPPER = prevPepper
  }
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
  assert.ok(out.length <= 25, 'a single request must not be able to write an unbounded number of rows')
})

// SEC-3: the per-request cap is tightened to 25 (one DynamoDB BatchWrite chunk).
// A typical flush is well under this; a 40-event batch is over and must be clamped.
test('normalizeEventBatch clamps a 40-event batch to the tightened 25-row cap', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ event: `e${i}` }))
  const out = normalizeEventBatch({ sessionId: 's', events }, {})
  assert.equal(out.length, 25, 'a 40-event batch normalizes to at most 25 rows')
})