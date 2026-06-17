import { utcDayBounds } from './events-shared.js'

// SDK-FREE so it can be unit-tested with a fake runner (no aws/src deps in the
// node --test baseline). The thin SDK wrapper lives in report-queries.js.

// The UTC calendar day (YYYY-MM-DD) `n` days before `day`.
function shiftDayBack(day, n) {
  const ms = new Date(`${day}T00:00:00.000Z`).getTime() - n * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

// Range-query one list partition's byCreatedAt GSI for every row whose createdAt
// falls within the target UTC day, draining pagination. `runQuery(params)` is the
// injected DynamoDB query runner (resolves to { Items, LastEvaluatedKey }).
//
// Bounds are half-open [start, nextDayStart) via the shared utcDayBounds helper —
// one definition of "a UTC day", reused everywhere, so the boundary can't drift.
//
// `lookbackDays > 0` widens the START bound back N days while keeping the same end.
// Chat transcript rows freeze createdAt at the session's FIRST turn, so a session
// that started just before midnight must still be fetched for the next day's report
// (its later turns are then filtered per-turn by aggregateChat). lookbackDays:1
// covers a session spanning a single UTC midnight.
export async function queryDayWith(runQuery, { tableName, listPk, day, indexName = 'byCreatedAt', lookbackDays = 0 }) {
  if (!tableName) return []
  const fromDay = lookbackDays > 0 ? shiftDayBack(day, lookbackDays) : day
  const { startIso } = utcDayBounds(fromDay)
  const { endIso } = utcDayBounds(day) // exclusive next-day midnight
  const items = []
  let startKey
  do {
    const response = await runQuery({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: 'listPk = :pk AND createdAt >= :start AND createdAt < :end',
      ExpressionAttributeValues: {
        ':pk': listPk,
        ':start': startIso,
        ':end': endIso
      },
      ExclusiveStartKey: startKey
    })
    items.push(...((response && response.Items) || []))
    startKey = response && response.LastEvaluatedKey
  } while (startKey)
  return items
}
