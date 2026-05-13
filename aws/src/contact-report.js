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
  const messages = []
  let startKey
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: process.env.CONTACT_MESSAGES_TABLE,
        FilterExpression:
          '#status <> :sent AND attempts > :zero AND (attribute_not_exists(#rs) OR #rs = :false)',
        ExpressionAttributeNames: { '#status': 'status', '#rs': 'reportSuppressed' },
        ExpressionAttributeValues: {
          ':sent': 'sent',
          ':zero': 0,
          ':false': false
        },
        ExclusiveStartKey: startKey
      })
    )
    messages.push(...(response.Items || []))
    startKey = response.LastEvaluatedKey
  } while (startKey)

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
