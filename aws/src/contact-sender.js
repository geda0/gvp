import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { sendViaResend } from './common/resend.js'
import { formatText, nowIso } from './common/contact-shared.js'

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

export const handler = async (event) => {
  for (const sqsRecord of event.Records || []) {
    const { id } = JSON.parse(sqsRecord.body)
    const record = await loadMessage(id)
    if (!record || record.status === 'sent') continue

    const attempts = (record.attempts || 0) + 1
    await markSending(id, attempts)

    try {
      const subject = record.subject ? `[Contact] ${record.subject}` : '[Contact] New message'
      const info = await sendViaResend({
        apiKey: process.env.RESEND_API_KEY,
        from: process.env.CONTACT_FROM_EMAIL,
        to: process.env.CONTACT_TO_EMAIL,
        subject,
        text: formatText(record),
        replyTo: record.email
      })

      await markSent(id, attempts, info?.id || null)
    } catch (error) {
      const errorMessage = String(error?.message || error)
      console.error('Failed to send contact message', { id, attempts, errorMessage })
      await markFailed(id, attempts, errorMessage)
      throw error
    }
  }
}
