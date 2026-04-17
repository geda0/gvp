import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb'
import { GetQueueAttributesCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { json, optionsResponse, unauthorized } from './common/contact-shared.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sqs = new SQSClient({})
const cloudwatch = new CloudWatchClient({})

function requireAdminKey(event) {
  const expected = process.env.ADMIN_API_KEY
  const provided =
    event?.headers?.['x-admin-key'] ||
    event?.headers?.['X-Admin-Key'] ||
    ''
  if (!expected || provided !== expected) return false
  return true
}

function getPath(event) {
  return event?.rawPath || event?.path || ''
}

function getMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || 'GET'
}

function parseLimit(event) {
  const raw = event?.queryStringParameters?.limit
  const n = Number(raw || 25)
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 25
}

async function listMessages(limit) {
  const response = await ddb.send(
    new ScanCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE
    })
  )
  const items = (response.Items || []).sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  )
  return items.slice(0, limit)
}

async function getSummary() {
  const response = await ddb.send(
    new ScanCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE
    })
  )
  const items = response.Items || []
  const summary = {
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    deadLettered: 0,
    total: items.length,
    mostRecentSuccess: null,
    mostRecentFailure: null
  }

  for (const item of items) {
    if (item.status === 'queued') summary.queued += 1
    if (item.status === 'sending') summary.sending += 1
    if (item.status === 'sent') summary.sent += 1
    if (item.status === 'failed') summary.failed += 1
    if (item.status === 'dead_lettered') summary.deadLettered += 1
  }

  const successes = items
    .filter((item) => item.status === 'sent' && item.deliveredAt)
    .sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt)))
  const failures = items
    .filter((item) => item.status !== 'sent' && item.lastError)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))

  summary.mostRecentSuccess = successes[0] || null
  summary.mostRecentFailure = failures[0] || null
  return summary
}

async function getMessage(id) {
  const response = await ddb.send(
    new GetCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      Key: { id }
    })
  )
  return response.Item || null
}

async function getHealth() {
  const [queueAttrs, dlqAttrs, alarms] = await Promise.all([
    sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: process.env.CONTACT_DELIVERY_QUEUE_URL,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
      })
    ),
    sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: process.env.CONTACT_DELIVERY_DLQ_URL,
        AttributeNames: ['ApproximateNumberOfMessages']
      })
    ),
    cloudwatch.send(
      new DescribeAlarmsCommand({
        AlarmNames: [process.env.CONTACT_DLQ_ALARM_NAME]
      })
    )
  ])

  return {
    apiConfigured: Boolean(
      process.env.CONTACT_MESSAGES_TABLE &&
      process.env.CONTACT_DELIVERY_QUEUE_URL &&
      process.env.CONTACT_DELIVERY_DLQ_URL
    ),
    queueVisible: Number(queueAttrs.Attributes?.ApproximateNumberOfMessages || 0),
    queueInFlight: Number(queueAttrs.Attributes?.ApproximateNumberOfMessagesNotVisible || 0),
    dlqVisible: Number(dlqAttrs.Attributes?.ApproximateNumberOfMessages || 0),
    alarmState: alarms.MetricAlarms?.[0]?.StateValue || 'UNKNOWN'
  }
}

async function retryMessage(id) {
  const message = await getMessage(id)
  if (!message) return { notFound: true }
  if (message.status === 'sent') return { alreadySent: true }
  if (message.status === 'queued' || message.status === 'sending') {
    return { alreadyInFlight: true }
  }
  if (message.status !== 'failed' && message.status !== 'dead_lettered') {
    return { invalidStatus: true, status: message.status || 'unknown' }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      Key: { id },
      UpdateExpression: 'SET #status = :status, lastError = :lastError',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'queued',
        ':lastError': null
      }
    })
  )

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.CONTACT_DELIVERY_QUEUE_URL,
      MessageBody: JSON.stringify({ id })
    })
  )

  return { ok: true }
}

export const handler = async (event) => {
  const method = getMethod(event)
  if (method === 'OPTIONS') return optionsResponse()
  if (!requireAdminKey(event)) return unauthorized()

  const path = getPath(event)

  if (method === 'GET' && path.endsWith('/summary')) {
    return json(200, await getSummary())
  }

  if (method === 'GET' && path.endsWith('/messages')) {
    return json(200, { items: await listMessages(parseLimit(event)) })
  }

  if (method === 'GET' && path.includes('/messages/')) {
    const id = path.split('/messages/')[1]
    const item = await getMessage(id)
    if (!item) return json(404, { error: 'Message not found' })
    return json(200, item)
  }

  if (method === 'GET' && path.endsWith('/health')) {
    return json(200, await getHealth())
  }

  if (method === 'POST' && path.includes('/retry/')) {
    const id = path.split('/retry/')[1]
    const result = await retryMessage(id)
    if (result.notFound) return json(404, { error: 'Message not found' })
    if (result.alreadySent) return json(400, { error: 'Message already sent' })
    if (result.alreadyInFlight) return json(409, { error: 'Message already queued or sending' })
    if (result.invalidStatus) {
      return json(400, { error: `Message cannot be retried from status: ${result.status}` })
    }
    return json(200, { ok: true, requeued: true })
  }

  return json(404, { error: 'Not found' })
}
