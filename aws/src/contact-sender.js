import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { sendViaResend } from './common/resend.js'
import { nowIso } from './common/contact-shared.js'
import { createSenderHandler } from './contact-sender-core.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

async function loadMessage(id) {
  const response = await ddb.send(
    new GetCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      Key: { id }
    })
  )
  return response.Item || null
}

async function markSending(id, attempts) {
  await ddb.send(
    new UpdateCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      Key: { id },
      UpdateExpression: 'SET #status = :status, attempts = :attempts',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'sending',
        ':attempts': attempts
      }
    })
  )
}

async function markSent(id, attempts, resendId) {
  await ddb.send(
    new UpdateCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      Key: { id },
      UpdateExpression:
        'SET #status = :status, attempts = :attempts, deliveredAt = :deliveredAt, resendId = :resendId, lastError = :lastError',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'sent',
        ':attempts': attempts,
        ':deliveredAt': nowIso(),
        ':resendId': resendId || null,
        ':lastError': null
      }
    })
  )
}

async function markFailed(id, attempts, errorMessage) {
  await ddb.send(
    new UpdateCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      Key: { id },
      UpdateExpression: 'SET #status = :status, attempts = :attempts, lastError = :lastError',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':attempts': attempts,
        ':lastError': errorMessage
      }
    })
  )
}

export const handler = createSenderHandler({
  store: { loadMessage, markSending, markSent, markFailed },
  sendEmail: sendViaResend
})
