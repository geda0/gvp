import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { sendViaResend } from './common/resend.js'
import { nowIso } from './common/contact-shared.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const LIST_PK = 'CONTACT'
const BY_CREATED_AT = 'byCreatedAt'

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
  // Query the byCreatedAt GSI (listPk = CONTACT) instead of a full-table scan.
  // Every contact item carries listPk: 'CONTACT' and the GSI projects ALL
  // attributes, so this returns the same rows as the old Scan while only
  // touching contact items. The failed/non-suppressed filter still runs
  // server-side via FilterExpression.
  const messages = []
  let startKey
  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: process.env.CONTACT_MESSAGES_TABLE,
        IndexName: BY_CREATED_AT,
        KeyConditionExpression: 'listPk = :pk',
        FilterExpression:
          '#status <> :sent AND attempts > :zero AND (attribute_not_exists(#rs) OR #rs = :false)',
        ExpressionAttributeNames: { '#status': 'status', '#rs': 'reportSuppressed' },
        ExpressionAttributeValues: {
          ':pk': LIST_PK,
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
