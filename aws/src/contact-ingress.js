import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import {
  buildMessageRecord,
  json,
  optionsResponse,
  parseJsonBody,
  validateMessage
} from './common/contact-shared.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sqs = new SQSClient({})

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'POST'
  if (method === 'OPTIONS') return optionsResponse()
  if (method !== 'POST') return json(405, { error: 'Method not allowed' })

  let payload
  try {
    payload = parseJsonBody(event)
  } catch (_) {
    return json(400, { error: 'Invalid JSON' })
  }

  const record = buildMessageRecord(payload, event?.headers || {})

  if (record.company) {
    return json(200, { ok: true, persisted: true, delivery: 'queued' })
  }

  const validationError = validateMessage(record)
  if (validationError) {
    return json(400, { error: validationError })
  }

  if (!process.env.CONTACT_MESSAGES_TABLE || !process.env.CONTACT_DELIVERY_QUEUE_URL) {
    return json(500, { error: 'Contact service is not configured.' })
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: process.env.CONTACT_MESSAGES_TABLE,
        Item: record,
        ConditionExpression: 'attribute_not_exists(id)'
      })
    )

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.CONTACT_DELIVERY_QUEUE_URL,
        MessageBody: JSON.stringify({
          id: record.id,
          idempotencyKey: record.idempotencyKey
        })
      })
    )

    return json(200, {
      ok: true,
      persisted: true,
      delivery: 'queued',
      id: record.id
    })
  } catch (error) {
    console.error('Failed to persist or enqueue contact message', {
      errorMessage: String(error?.message || error),
      recordId: record.id
    })
    return json(500, {
      error: 'Message could not be queued. Please try again.'
    })
  }
}
