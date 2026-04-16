import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { sendViaResend } from './common/resend.js'
import { nowIso } from './common/contact-shared.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

function buildReport(messages) {
  return [
    `Contact delivery failure report`,
    `Generated: ${nowIso()}`,
    '',
    ...messages.map((msg) =>
      [
        `Message: ${msg.id}`,
        `Status: ${msg.status}`,
        `Attempts: ${msg.attempts || 0}`,
        `From: ${msg.name || '—'} <${msg.email || '—'}>`,
        `Subject: ${msg.subject || '—'}`,
        `Last error: ${msg.lastError || '—'}`,
        ''
      ].join('\n')
    )
  ].join('\n')
}

export const handler = async () => {
  const response = await ddb.send(
    new ScanCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      FilterExpression: '#status <> :sent AND attempts > :zero',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sent': 'sent',
        ':zero': 0
      }
    })
  )

  const messages = response.Items || []
  if (!messages.length) {
    return { statusCode: 200, body: 'No failed messages' }
  }

  await sendViaResend({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.CONTACT_FROM_EMAIL,
    to: process.env.CONTACT_REPORT_EMAIL || process.env.CONTACT_TO_EMAIL,
    subject: '[Contact] Failure report',
    text: buildReport(messages),
    replyTo: null
  })

  return { statusCode: 200, body: `Reported ${messages.length} message(s)` }
}
