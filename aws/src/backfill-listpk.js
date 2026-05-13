/**
 * One-off: set listPk = CONTACT on contact messages missing it (DynamoDB GSI byCreatedAt).
 *
 * Run from aws/src (so node_modules resolves):
 *   export CONTACT_MESSAGES_TABLE=YourTableName
 *   export AWS_REGION=us-east-2
 *   cd aws/src && node backfill-listpk.js
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const table = process.env.CONTACT_MESSAGES_TABLE
if (!table) {
  console.error('Set CONTACT_MESSAGES_TABLE to the DynamoDB table name.')
  process.exit(1)
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

let startKey
let updated = 0
let scanned = 0
do {
  const response = await ddb.send(
    new ScanCommand({
      TableName: table,
      ProjectionExpression: 'id, listPk',
      ExclusiveStartKey: startKey
    })
  )
  for (const item of response.Items || []) {
    scanned += 1
    if (item.listPk) continue
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { id: item.id },
          UpdateExpression: 'SET listPk = :p',
          ExpressionAttributeValues: { ':p': 'CONTACT' },
          ConditionExpression: 'attribute_not_exists(listPk)'
        })
      )
      updated += 1
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') continue
      throw e
    }
  }
  startKey = response.LastEvaluatedKey
} while (startKey)

console.log(`Scanned ${scanned} item(s), updated ${updated} with listPk.`)
