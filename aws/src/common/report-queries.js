import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { queryDayWith } from './report-queries-core.js'

// Thin SDK wrapper: the only place the AWS SDK is imported for day-range queries.
// The pagination + bounds logic lives in report-queries-core.js (SDK-free, unit-
// tested with a fake runner, so the node --test baseline needs no aws/src deps).
export function queryDay(ddb, opts) {
  return queryDayWith((params) => ddb.send(new QueryCommand(params)), opts)
}

export { queryDayWith }
