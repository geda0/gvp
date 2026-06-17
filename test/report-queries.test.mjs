import test from 'node:test'
import assert from 'node:assert/strict'
import { queryDayWith } from '../aws/src/common/report-queries-core.js'

// A fake query runner that returns a queued list of responses and records the
// params it was called with. (SDK-free: the production wrapper in report-queries.js
// adapts this to ddb.send(new QueryCommand(params)).)
function fakeRunner(pages) {
  const calls = []
  let i = 0
  const run = async (params) => {
    calls.push(params)
    return pages[i++] || { Items: [] }
  }
  run.calls = calls
  return run
}

test('queryDayWith drains every page following LastEvaluatedKey', async () => {
  const run = fakeRunner([
    { Items: [{ id: 1 }, { id: 2 }], LastEvaluatedKey: { id: 2 } },
    { Items: [{ id: 3 }] } // no LastEvaluatedKey -> stop
  ])
  const items = await queryDayWith(run, { tableName: 't', listPk: 'EVENT', day: '2026-06-16' })

  assert.equal(items.length, 3, 'rows from BOTH pages are returned, not just the first')
  assert.deepEqual(items.map((r) => r.id), [1, 2, 3])
  assert.equal(run.calls.length, 2, 'paginated until LastEvaluatedKey was undefined')
  assert.equal(run.calls[0].ExclusiveStartKey, undefined, 'first page has no start key')
  assert.deepEqual(run.calls[1].ExclusiveStartKey, { id: 2 }, 'second page threads the prior LastEvaluatedKey')
})

test('queryDayWith ranges a single UTC day with a DynamoDB-valid BETWEEN key condition', async () => {
  const run = fakeRunner([{ Items: [] }])
  await queryDayWith(run, { tableName: 't', listPk: 'EVENT', day: '2026-06-16' })

  const params = run.calls[0]
  // DynamoDB allows only ONE condition per key, so a sort-key range MUST be BETWEEN
  // (not `>= :start AND < :end`, which is rejected with a ValidationException).
  assert.match(
    params.KeyConditionExpression,
    /createdAt BETWEEN :start AND :end/,
    'sort-key range uses BETWEEN (one condition per key)'
  )
  assert.doesNotMatch(params.KeyConditionExpression, /createdAt\s*(>=|<)/, 'never two comparators on createdAt')
  // fractionless lower bound so it sorts at/below both `.000Z` and `+00:00` midnight forms (AGG-1)
  assert.equal(params.ExpressionAttributeValues[':start'], '2026-06-16T00:00:00')
  assert.equal(params.ExpressionAttributeValues[':end'], '2026-06-16T23:59:59.999Z', 'inclusive end = last ms of the day')
  assert.equal(params.ExpressionAttributeValues[':pk'], 'EVENT')
})

test('queryDayWith lookbackDays extends the start bound back N days (for midnight-spanning chat sessions)', async () => {
  const run = fakeRunner([{ Items: [] }])
  await queryDayWith(run, { tableName: 't', listPk: 'CHAT_TRANSCRIPT', day: '2026-06-16', lookbackDays: 1 })

  const params = run.calls[0]
  assert.equal(params.ExpressionAttributeValues[':start'], '2026-06-15T00:00:00', 'start moved back one day (fractionless lower bound)')
  assert.equal(params.ExpressionAttributeValues[':end'], '2026-06-16T23:59:59.999Z', 'end stays the last ms of the target day')
})

test('queryDayWith returns [] without a tableName and never calls the runner', async () => {
  const run = fakeRunner([{ Items: [{ id: 1 }] }])
  const items = await queryDayWith(run, { tableName: '', listPk: 'EVENT', day: '2026-06-16' })
  assert.deepEqual(items, [])
  assert.equal(run.calls.length, 0)
})

// AGG-1: chat rows are written by the Python chat container, whose ISO timestamps
// render midnight as `...T00:00:00+00:00` (offset form) rather than Node's
// `...T00:00:00.000Z` (Z + millis). DynamoDB's BETWEEN is a lexicographic string
// compare, and `+` (0x2B) sorts BELOW `.` (0x2E), so a `.000Z` lower bound EXCLUDES
// a `+00:00` midnight row. A fractionless `T00:00:00` lower bound sorts at/below
// both forms so the boundary row is captured.
test('queryDayWith :start bound sorts at/below both +00:00 and .000Z midnight forms (AGG-1)', async () => {
  const run = fakeRunner([{ Items: [] }])
  await queryDayWith(run, { tableName: 't', listPk: 'CHAT_TRANSCRIPT', day: '2026-06-16' })

  const start = run.calls[0].ExpressionAttributeValues[':start']
  const pythonMidnight = '2026-06-16T00:00:00+00:00' // Python-emitted +00:00 form
  const nodeMidnight = '2026-06-16T00:00:00.000Z' // Node Date#toISOString form

  assert.ok(
    pythonMidnight >= start,
    `a +00:00 midnight createdAt (${pythonMidnight}) must sort at/above :start (${start}) so the boundary chat row is INCLUDED`
  )
  assert.ok(
    nodeMidnight >= start,
    `a .000Z midnight createdAt (${nodeMidnight}) must still sort at/above :start (${start})`
  )
  // end-bound behavior is unchanged: inclusive last ms of the target day
  assert.equal(run.calls[0].ExpressionAttributeValues[':end'], '2026-06-16T23:59:59.999Z')
})

// EV-1: a flood of rows in a single partition/day must not be materialized
// without bound — queryDayWith caps the number of items it collects so a
// pathological day can't grow the Lambda heap without limit.
test('queryDayWith caps the materialized item count under a flood (EV-1)', async () => {
  // 250 rows spread across pages; the cap is below that.
  const page = (start, n) => ({
    Items: Array.from({ length: n }, (_, i) => ({ id: start + i })),
    LastEvaluatedKey: { id: start + n - 1 }
  })
  const run = fakeRunner([page(0, 100), page(100, 100), { Items: Array.from({ length: 50 }, (_, i) => ({ id: 200 + i })) }])

  const items = await queryDayWith(run, { tableName: 't', listPk: 'EVENT', day: '2026-06-16', maxItems: 150 })

  assert.equal(items.length, 150, 'collection is capped at maxItems, not the full 250-row flood')
  assert.ok(run.calls.length <= 2, 'stops paginating once the cap is reached instead of draining the whole flood')
})

test('queryDayWith returns all rows when the day is under the cap (EV-1 non-regression)', async () => {
  const run = fakeRunner([
    { Items: [{ id: 1 }, { id: 2 }], LastEvaluatedKey: { id: 2 } },
    { Items: [{ id: 3 }] }
  ])
  const items = await queryDayWith(run, { tableName: 't', listPk: 'EVENT', day: '2026-06-16', maxItems: 1000 })
  assert.deepEqual(items.map((r) => r.id), [1, 2, 3], 'an under-cap day is returned whole')
})
