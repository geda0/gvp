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

test('queryDayWith ranges a single UTC day with half-open [start, nextDayStart) bounds', async () => {
  const run = fakeRunner([{ Items: [] }])
  await queryDayWith(run, { tableName: 't', listPk: 'EVENT', day: '2026-06-16' })

  const params = run.calls[0]
  assert.match(
    params.KeyConditionExpression,
    />=\s*:start.*<\s*:end/,
    'uses a half-open >= start AND < end range (not an inclusive BETWEEN .999Z)'
  )
  assert.equal(params.ExpressionAttributeValues[':start'], '2026-06-16T00:00:00.000Z')
  assert.equal(params.ExpressionAttributeValues[':end'], '2026-06-17T00:00:00.000Z', 'end is the EXCLUSIVE next-day midnight')
  assert.equal(params.ExpressionAttributeValues[':pk'], 'EVENT')
})

test('queryDayWith lookbackDays extends the start bound back N days (for midnight-spanning chat sessions)', async () => {
  const run = fakeRunner([{ Items: [] }])
  await queryDayWith(run, { tableName: 't', listPk: 'CHAT_TRANSCRIPT', day: '2026-06-16', lookbackDays: 1 })

  const params = run.calls[0]
  assert.equal(params.ExpressionAttributeValues[':start'], '2026-06-15T00:00:00.000Z', 'start moved back one day')
  assert.equal(params.ExpressionAttributeValues[':end'], '2026-06-17T00:00:00.000Z', 'end still excludes the day after the target')
})

test('queryDayWith returns [] without a tableName and never calls the runner', async () => {
  const run = fakeRunner([{ Items: [{ id: 1 }] }])
  const items = await queryDayWith(run, { tableName: '', listPk: 'EVENT', day: '2026-06-16' })
  assert.deepEqual(items, [])
  assert.equal(run.calls.length, 0)
})
