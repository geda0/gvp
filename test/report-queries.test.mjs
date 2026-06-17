import test from 'node:test'
import assert from 'node:assert/strict'
import { queryDay } from '../aws/src/common/report-queries.js'

// A fake DynamoDBDocumentClient that returns a queued list of responses and
// records the QueryCommand input it was called with.
function fakeDdb(pages) {
  const calls = []
  let i = 0
  return {
    calls,
    send: async (cmd) => {
      calls.push(cmd.input)
      return pages[i++] || { Items: [] }
    }
  }
}

test('queryDay drains every page following LastEvaluatedKey', async () => {
  const ddb = fakeDdb([
    { Items: [{ id: 1 }, { id: 2 }], LastEvaluatedKey: { id: 2 } },
    { Items: [{ id: 3 }] } // no LastEvaluatedKey -> stop
  ])
  const items = await queryDay(ddb, { tableName: 't', listPk: 'EVENT', day: '2026-06-16' })

  assert.equal(items.length, 3, 'rows from BOTH pages are returned, not just the first')
  assert.deepEqual(items.map((r) => r.id), [1, 2, 3])
  assert.equal(ddb.calls.length, 2, 'paginated until LastEvaluatedKey was undefined')
  assert.equal(ddb.calls[0].ExclusiveStartKey, undefined, 'first page has no start key')
  assert.deepEqual(ddb.calls[1].ExclusiveStartKey, { id: 2 }, 'second page threads the prior LastEvaluatedKey')
})

test('queryDay ranges a single UTC day with half-open [start, nextDayStart) bounds', async () => {
  const ddb = fakeDdb([{ Items: [] }])
  await queryDay(ddb, { tableName: 't', listPk: 'EVENT', day: '2026-06-16' })

  const input = ddb.calls[0]
  assert.match(
    input.KeyConditionExpression,
    />=\s*:start.*<\s*:end/,
    'uses a half-open >= start AND < end range (not an inclusive BETWEEN .999Z)'
  )
  assert.equal(input.ExpressionAttributeValues[':start'], '2026-06-16T00:00:00.000Z')
  assert.equal(input.ExpressionAttributeValues[':end'], '2026-06-17T00:00:00.000Z', 'end is the EXCLUSIVE next-day midnight')
  assert.equal(input.ExpressionAttributeValues[':pk'], 'EVENT')
})

test('queryDay lookbackDays extends the start bound back N days (for midnight-spanning chat sessions)', async () => {
  const ddb = fakeDdb([{ Items: [] }])
  await queryDay(ddb, { tableName: 't', listPk: 'CHAT_TRANSCRIPT', day: '2026-06-16', lookbackDays: 1 })

  const input = ddb.calls[0]
  assert.equal(input.ExpressionAttributeValues[':start'], '2026-06-15T00:00:00.000Z', 'start moved back one day')
  assert.equal(input.ExpressionAttributeValues[':end'], '2026-06-17T00:00:00.000Z', 'end still excludes the day after the target')
})

test('queryDay returns [] without a tableName and never calls the store', async () => {
  const ddb = fakeDdb([{ Items: [{ id: 1 }] }])
  const items = await queryDay(ddb, { tableName: '', listPk: 'EVENT', day: '2026-06-16' })
  assert.deepEqual(items, [])
  assert.equal(ddb.calls.length, 0)
})
