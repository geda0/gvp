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
// DynamoDB allows only ONE condition per key, so the createdAt range MUST be a
// single BETWEEN (an inclusive [start, end] over millisecond-precision ISO
// timestamps) — `createdAt >= :start AND createdAt < :end` is rejected with a
// ValidationException ("must only contain one condition per key").
//
// `lookbackDays > 0` widens the START bound back N days while keeping the same end.
// Chat transcript rows freeze createdAt at the session's FIRST turn, so a session
// that started just before midnight must still be fetched for the next day's report
// (its later turns are then filtered per-turn by aggregateChat). lookbackDays:1
// covers a session spanning a single UTC midnight.
//
// AGG-1: the lower bound is FRACTIONLESS (`${day}T00:00:00`, no `.000Z`). DynamoDB's
// BETWEEN is a lexicographic string compare; the Python chat container renders
// midnight as `...T00:00:00+00:00` (offset form), and `+` (0x2B) sorts BELOW `.`
// (0x2E), so a `.000Z` lower bound would EXCLUDE a `+00:00` midnight row. A fractionless
// bound has nothing after the seconds, so it sorts at/below BOTH the `.000Z` and
// `+00:00` midnight forms and captures the boundary row.
//
// EV-1: `maxItems` caps how many rows are materialized so a pathological day (a flood
// of rows in one partition) can't grow the Lambda heap without bound. Pagination stops
// once the cap is reached. Default is high enough that a normal day is returned whole.
export async function queryDayWith(runQuery, { tableName, listPk, day, indexName = 'byCreatedAt', lookbackDays = 0, maxItems = 50000 }) {
  if (!tableName) return []
  const fromDay = lookbackDays > 0 ? shiftDayBack(day, lookbackDays) : day
  const startIso = `${fromDay}T00:00:00` // fractionless: sorts at/below both `.000Z` and `+00:00`
  const endIso = `${day}T23:59:59.999Z` // inclusive last ms of the target day
  const items = []
  let startKey
  do {
    const response = await runQuery({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: 'listPk = :pk AND createdAt BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': listPk,
        ':start': startIso,
        ':end': endIso
      },
      ExclusiveStartKey: startKey
    })
    items.push(...((response && response.Items) || []))
    if (items.length >= maxItems) {
      items.length = maxItems // cap the materialized set; stop draining the flood
      break
    }
    startKey = response && response.LastEvaluatedKey
  } while (startKey)
  return items
}
