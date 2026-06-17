import test from 'node:test'
import assert from 'node:assert/strict'
import { persistEventRows } from '../aws/src/events-ingress-core.js'

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, listPk: 'EVENT' }))
const noSleep = async () => {}

test('persistEventRows writes in <=25-item BatchWrite chunks', async () => {
  const sizes = []
  await persistEventRows({
    tableName: 'site-events',
    rows: rows(51),
    sleep: noSleep,
    batchWrite: async (requestItems) => {
      sizes.push(requestItems['site-events'].length)
      return {}
    }
  })
  assert.deepEqual(sizes, [25, 25, 1], 'DynamoDB caps BatchWrite at 25 — 51 rows => 25/25/1')
})

test('persistEventRows retries UnprocessedItems until drained, never losing rows', async () => {
  let call = 0
  const seen = []
  await persistEventRows({
    tableName: 't',
    rows: rows(3),
    sleep: noSleep,
    batchWrite: async (requestItems) => {
      call += 1
      const items = requestItems['t']
      seen.push(items.length)
      // First attempt: one item comes back unprocessed; second attempt: clean.
      if (call === 1) return { UnprocessedItems: { t: [items[2]] } }
      return {}
    }
  })
  assert.equal(call, 2, 'a non-empty UnprocessedItems triggers a retry')
  assert.deepEqual(seen, [3, 1], 'the retry re-sends ONLY the unprocessed item, not the whole chunk')
})

test('persistEventRows throws when items stay unprocessed (handler must report 500, not false success)', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      persistEventRows({
        tableName: 't',
        rows: rows(1),
        maxAttempts: 3,
        sleep: noSleep,
        batchWrite: async (requestItems) => {
          calls += 1
          return { UnprocessedItems: { t: requestItems['t'] } } // never drains
        }
      }),
    /unprocessed/i,
    'persistent throttling must surface as an error, not a silent drop'
  )
  assert.equal(calls, 3, 'gives up after maxAttempts')
})
