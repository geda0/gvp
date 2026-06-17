import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import { createEventsHandler, persistEventRows } from './events-ingress-core.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

// Thin wrapper: own the AWS SDK here; the chunking + UnprocessedItems drain lives
// in events-ingress-core.js (unit-tested with an injected batchWrite).
const persistEvents = (rows) =>
  persistEventRows({
    tableName: process.env.SITE_EVENTS_TABLE,
    rows,
    batchWrite: (RequestItems) => ddb.send(new BatchWriteCommand({ RequestItems }))
  })

export const handler = createEventsHandler({ persistEvents })
