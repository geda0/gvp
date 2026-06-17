import test from 'node:test'
import assert from 'node:assert/strict'
import { getSessionEvents } from '../aws/src/contact-admin.js'

// S28 (TC-03) — handler-level test for getSessionEvents.
//
// getSessionEvents resolves a UTC day from the (optional) ?date param, then runs a
// day-range GSI query for the EVENT partition. The query is injected as a fake here
// (the seam) so we can assert the resolved `day` and the lookbackDays passthrough
// without standing up DynamoDB. We assert the *behavior at the boundary*: which day
// the handler asks the store for, and the range knobs it threads through.

// A fake queryDay that records the params it was called with and returns no rows.
function fakeQueryDay() {
  const calls = []
  const fn = async (_ddb, params) => {
    calls.push(params)
    return []
  }
  fn.calls = calls
  return fn
}

const todayUtc = () => new Date().toISOString().slice(0, 10)

test('getSessionEvents defaults to today (UTC) when no ?date is supplied', async () => {
  const queryDay = fakeQueryDay()
  const res = await getSessionEvents('sess-1', undefined, queryDay)

  assert.equal(res.day, todayUtc(), 'response day defaults to today (UTC)')
  assert.equal(queryDay.calls[0].day, todayUtc(), 'the store is queried for today (UTC)')
})

test('getSessionEvents rejects a malformed ?date and falls back to today (UTC)', async () => {
  const queryDay = fakeQueryDay()
  // Not an ISO YYYY-MM-DD: must NOT be threaded through to the query.
  const res = await getSessionEvents('sess-1', '2026-6-1; DROP', queryDay)

  assert.equal(res.day, todayUtc(), 'a malformed date is rejected; day falls back to today')
  assert.equal(queryDay.calls[0].day, todayUtc(), 'malformed date never reaches the store query')
})

test('getSessionEvents honors a well-formed ?date', async () => {
  const queryDay = fakeQueryDay()
  const res = await getSessionEvents('sess-1', '2026-01-15', queryDay)

  assert.equal(res.day, '2026-01-15', 'a valid YYYY-MM-DD date is used as the day')
  assert.equal(queryDay.calls[0].day, '2026-01-15', 'the valid date is threaded to the store query')
})

test('getSessionEvents threads lookbackDays:1 to the day-range query', async () => {
  const queryDay = fakeQueryDay()
  await getSessionEvents('sess-1', '2026-01-15', queryDay)

  // lookbackDays:1 lets a session that began just before midnight surface its
  // post-midnight turns on the right day.
  assert.equal(queryDay.calls[0].lookbackDays, 1, 'the query is run with lookbackDays:1')
})
