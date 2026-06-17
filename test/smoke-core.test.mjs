import test from 'node:test'
import assert from 'node:assert/strict'
import { rollupSmoke, timedCheck } from '../aws/src/common/smoke-core.js'

// A fake monotonic clock so latency is deterministic in tests.
function fakeClock(times) {
  let i = 0
  return () => times[Math.min(i++, times.length - 1)]
}

test('rollupSmoke: no checks => overall pass', () => {
  const r = rollupSmoke([], 'cheap')
  assert.equal(r.overall, 'pass')
  assert.equal(r.depth, 'cheap', 'echoes the requested depth')
  assert.ok(Array.isArray(r.checks) && r.checks.length === 0)
  assert.ok(r.generatedAt, 'records when it was generated')
})

test('rollupSmoke: overall is the WORST status across checks (pass < warn < fail)', () => {
  assert.equal(rollupSmoke([{ name: 'a', status: 'pass' }, { name: 'b', status: 'warn' }]).overall, 'warn')
  assert.equal(
    rollupSmoke([{ name: 'a', status: 'pass' }, { name: 'b', status: 'warn' }, { name: 'c', status: 'fail' }]).overall,
    'fail'
  )
  assert.equal(rollupSmoke([{ name: 'a', status: 'pass' }, { name: 'b', status: 'pass' }]).overall, 'pass')
})

test('rollupSmoke: preserves check order and fields (latencyMs, detail, cost)', () => {
  const checks = [
    { name: 'ddb', status: 'pass', latencyMs: 12, detail: 'ok', cost: 'free' },
    { name: 'gemini_live', status: 'pass', latencyMs: 340, detail: '1-token live', cost: 'paid' }
  ]
  const r = rollupSmoke(checks, 'deep')
  assert.equal(r.depth, 'deep')
  assert.deepEqual(r.checks.map((c) => c.name), ['ddb', 'gemini_live'])
  assert.equal(r.checks[0].latencyMs, 12)
  assert.equal(r.checks[1].cost, 'paid', 'cost pill survives the rollup')
})

test('rollupSmoke: an unknown/missing status counts as fail (fail-safe)', () => {
  assert.equal(rollupSmoke([{ name: 'x' }]).overall, 'fail')
  assert.equal(rollupSmoke([{ name: 'x', status: 'bogus' }]).overall, 'fail')
})

test('timedCheck: a resolving probe => pass with measured latency + cost', async () => {
  const c = await timedCheck('ddb', async () => 'queried', { cost: 'free', now: fakeClock([1000, 1012]) })
  assert.equal(c.name, 'ddb')
  assert.equal(c.status, 'pass')
  assert.equal(c.latencyMs, 12)
  assert.equal(c.detail, 'queried')
  assert.equal(c.cost, 'free')
})

test('timedCheck: a throwing probe => fail with the error message, never raises', async () => {
  const c = await timedCheck('gemini_live', async () => { throw new Error('model 503') }, { cost: 'paid', now: fakeClock([0, 8000]) })
  assert.equal(c.status, 'fail')
  assert.match(c.detail, /model 503/)
  assert.equal(c.latencyMs, 8000)
  assert.equal(c.cost, 'paid', 'a failed paid probe still records cost')
})

test('timedCheck: a probe may return {status:"warn", detail} to signal degraded', async () => {
  const c = await timedCheck('pipeline', async () => ({ status: 'warn', detail: 'DLQ has 2' }), { now: fakeClock([0, 5]) })
  assert.equal(c.status, 'warn')
  assert.equal(c.detail, 'DLQ has 2')
  assert.equal(c.cost, 'free', 'cost defaults to free')
})
