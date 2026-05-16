import crypto from 'node:crypto'
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb'
import { GetQueueAttributesCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import {
  json as jsonBase,
  optionsResponse,
  resolveCorsOrigin,
  unauthorized as unauthorizedBase
} from './common/contact-shared.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sqs = new SQSClient({})
const cloudwatch = new CloudWatchClient({})

const LIST_PK = 'CONTACT'
const BY_CREATED_AT = 'byCreatedAt'
const CHAT_LIST_PK = 'CHAT_TRANSCRIPT'
const CHAT_FLAGS = [
  'no_retrieval_match',
  'negative_feedback',
  'possible_refusal',
  'long_conversation',
  'tool_offered_not_taken'
]

function requireAdminKey(event) {
  const expected = process.env.ADMIN_API_KEY
  const provided =
    event?.headers?.['x-admin-key'] ||
    event?.headers?.['X-Admin-Key'] ||
    ''
  if (!expected || typeof provided !== 'string' || !provided) return false
  try {
    const eh = crypto.createHash('sha256').update(expected, 'utf8').digest()
    const ph = crypto.createHash('sha256').update(provided, 'utf8').digest()
    return crypto.timingSafeEqual(eh, ph)
  } catch {
    return false
  }
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

function parseBody(event) {
  if (!event?.body) return {}
  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    return JSON.parse(body)
  } catch {
    return {}
  }
}

function decodeCursor(raw) {
  if (!raw) return undefined
  try {
    const s = String(raw).trim()
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function encodeCursor(key) {
  if (!key || !Object.keys(key).length) return ''
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

function tableOrFallback(tableName) {
  return String(tableName || process.env.CONTACT_MESSAGES_TABLE || '').trim()
}

/** Full table scan sorted by createdAt desc — fallback when GSI has no rows (legacy items without listPk). */
async function legacyScanRecentMessages(limit) {
  const rows = []
  let startKey
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: process.env.CONTACT_MESSAGES_TABLE,
        ExclusiveStartKey: startKey
      })
    )
    rows.push(...(response.Items || []))
    startKey = response.LastEvaluatedKey
  } while (startKey)
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return rows.slice(0, limit)
}

async function listMessages(limit, cursorRaw) {
  const exclusiveStartKey = decodeCursor(cursorRaw)

  if (exclusiveStartKey) {
    const response = await ddb.send(
      new QueryCommand({
        TableName: process.env.CONTACT_MESSAGES_TABLE,
        IndexName: BY_CREATED_AT,
        KeyConditionExpression: 'listPk = :pk',
        ExpressionAttributeValues: {
          ':pk': LIST_PK
        },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey
      })
    )
    const items = response.Items || []
    return {
      items,
      nextCursor: encodeCursor(response.LastEvaluatedKey)
    }
  }

  let qResponse
  try {
    qResponse = await ddb.send(
      new QueryCommand({
        TableName: process.env.CONTACT_MESSAGES_TABLE,
        IndexName: BY_CREATED_AT,
        KeyConditionExpression: 'listPk = :pk',
        ExpressionAttributeValues: {
          ':pk': LIST_PK
        },
        ScanIndexForward: false,
        Limit: limit
      })
    )
  } catch {
    const items = await legacyScanRecentMessages(limit)
    return {
      items,
      nextCursor: ''
    }
  }

  let items = qResponse.Items || []
  let nextCursor = encodeCursor(qResponse.LastEvaluatedKey)

  if (items.length === 0 && !qResponse.LastEvaluatedKey) {
    items = await legacyScanRecentMessages(limit)
    nextCursor = ''
  }

  return {
    items,
    nextCursor
  }
}

async function getSummary() {
  const summary = {
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    deadLettered: 0,
    total: 0,
    mostRecentSuccess: null,
    mostRecentFailure: null
  }

  let bestSuccess = null
  let bestFailure = null
  let startKey

  // Query the byCreatedAt GSI (listPk = CONTACT) instead of a full-table scan.
  // Every contact item carries listPk: 'CONTACT', so this tallies the same rows
  // while only touching contact items. ProjectionExpression keeps the payload
  // small. Legacy items written before listPk backfill are not in the GSI; run
  // backfill-listpk.js to include them.
  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: process.env.CONTACT_MESSAGES_TABLE,
        IndexName: BY_CREATED_AT,
        KeyConditionExpression: 'listPk = :pk',
        ProjectionExpression: '#st, createdAt, deliveredAt, lastError, email, id',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':pk': LIST_PK },
        ExclusiveStartKey: startKey
      })
    )
    const items = response.Items || []
    summary.total += items.length

    for (const item of items) {
      if (item.status === 'queued') summary.queued += 1
      if (item.status === 'sending') summary.sending += 1
      if (item.status === 'sent') summary.sent += 1
      if (item.status === 'failed') summary.failed += 1
      if (item.status === 'dead_lettered') summary.deadLettered += 1

      if (item.status === 'sent' && item.deliveredAt) {
        if (!bestSuccess || String(item.deliveredAt) > String(bestSuccess.deliveredAt)) {
          bestSuccess = item
        }
      }
      if (item.status !== 'sent' && item.lastError) {
        if (!bestFailure || String(item.createdAt || '') > String(bestFailure.createdAt || '')) {
          bestFailure = item
        }
      }
    }

    startKey = response.LastEvaluatedKey
  } while (startKey)

  summary.mostRecentSuccess = bestSuccess
  summary.mostRecentFailure = bestFailure
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

function chatTableName() {
  // Never fall back to CONTACT_MESSAGES_TABLE — that GSI uses a different listPk
  // and would make the transcript tab look "empty" with no obvious error.
  return String(process.env.CHAT_TRANSCRIPTS_TABLE || '').trim()
}

function hasChatTranscriptTable() {
  return Boolean(chatTableName())
}

function normalizeChatItem(item) {
  const turns = Array.isArray(item?.turns) ? item.turns : []
  const lastTurn = turns.length ? turns[turns.length - 1] : null
  const reviewed = Boolean(item?.reviewed)
  const flags = typeof item?.flags === 'object' && item.flags !== null
    ? item.flags
    : {}

  // --- Per-conversation telemetry roll-up ------------------------------
  // Each turn carries its own modality + audio/duration stats (see
  // docker/chat/app/main.py /api/chat and /api/live/transcript). We
  // aggregate per item once here so list views, detail views, AND the
  // global summary all share the same field names without re-doing the
  // math three times.
  let voiceTurnCount = 0
  let textTurnCount = 0
  let totalToolCalls = 0
  let interruptedTurns = 0
  let totalAudioInBytes = 0
  let totalAudioOutBytes = 0
  let totalVoiceDurationMs = 0
  let textLatencySumMs = 0
  let textLatencySamples = 0
  const transports = {}            // 'relay' | 'direct_google' | 'live' -> count
  const toolHistogram = {}          // tool name -> invocation count
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue
    const modality = t.modality === 'text' || t.modality === 'voice'
      ? t.modality
      : (t.transport || t.audioInBytes || t.audioOutBytes ? 'voice' : 'text')
    if (modality === 'voice') {
      voiceTurnCount += 1
      const transport = String(t.transport || 'live')
      transports[transport] = (transports[transport] || 0) + 1
      if (Number.isFinite(t.audioInBytes)) totalAudioInBytes += Number(t.audioInBytes)
      if (Number.isFinite(t.audioOutBytes)) totalAudioOutBytes += Number(t.audioOutBytes)
      if (Number.isFinite(t.turnDurationMs)) totalVoiceDurationMs += Number(t.turnDurationMs)
      if (t.interrupted) interruptedTurns += 1
    } else {
      textTurnCount += 1
      if (Number.isFinite(t.latencyMs)) {
        textLatencySumMs += Number(t.latencyMs)
        textLatencySamples += 1
      }
    }
    const calls = Array.isArray(t.toolCalls) ? t.toolCalls : []
    for (const call of calls) {
      const name = String(call?.name || '').trim() || 'unknown'
      toolHistogram[name] = (toolHistogram[name] || 0) + 1
      totalToolCalls += 1
    }
  }
  const modality = voiceTurnCount > 0 && textTurnCount === 0
    ? 'voice'
    : (textTurnCount > 0 && voiceTurnCount === 0 ? 'text' : (voiceTurnCount ? 'mixed' : 'text'))

  return {
    id: item?.id || '',
    createdAt: item?.createdAt || '',
    updatedAt: item?.updatedAt || item?.createdAt || '',
    promptVersion: item?.promptVersion || 'unknown',
    reviewed,
    adminNotes: typeof item?.adminNotes === 'string' ? item.adminNotes : '',
    model: item?.model || '',
    provider: item?.provider || '',
    turnCount: Number(item?.turnCount || turns.length || 0),
    flagged: Boolean(item?.flagged),
    flags: CHAT_FLAGS.reduce((acc, name) => {
      acc[name] = Boolean(flags?.[name])
      return acc
    }, {}),
    turns,
    lastUserMessage: lastTurn?.requestMessages?.filter?.((m) => m?.role === 'user')?.at?.(-1)?.content || '',
    lastReply: lastTurn?.reply || '',
    // Aggregated telemetry — list rows use modality / voiceTurnCount / etc.
    // for badges; the summary endpoint sums these across all items.
    modality,
    voiceTurnCount,
    textTurnCount,
    totalToolCalls,
    interruptedTurns,
    totalAudioInBytes,
    totalAudioOutBytes,
    totalVoiceDurationMs,
    textLatencySumMs,
    textLatencySamples,
    transports,
    toolHistogram
  }
}

function parseChatFilters(event) {
  const query = event?.queryStringParameters || {}
  const rawReviewed = String(query.reviewed ?? '').trim().toLowerCase()
  let reviewed
  if (rawReviewed === 'true') reviewed = true
  if (rawReviewed === 'false') reviewed = false

  const promptVersion = String(query.promptVersion || '').trim()
  const flags = String(query.flags || '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => CHAT_FLAGS.includes(f))

  return { reviewed, promptVersion, flags }
}

function chatItemMatchesFilters(item, filters) {
  if (typeof filters.reviewed === 'boolean' && Boolean(item.reviewed) !== filters.reviewed) {
    return false
  }
  if (filters.promptVersion && item.promptVersion !== filters.promptVersion) {
    return false
  }
  if (filters.flags.length > 0) {
    const rowFlags = item.flags || {}
    for (const flag of filters.flags) {
      if (!rowFlags[flag]) return false
    }
  }
  return true
}

async function listChatTranscripts(limit, cursorRaw, filters) {
  const tableName = chatTableName()
  let startKey = decodeCursor(cursorRaw)
  const items = []
  let exhausted = false

  // Loop until we have `limit` matching items OR run out of data. Critical:
  // the OLD code pulled Limit=limit*2 and then `items.slice(0, limit)`, but
  // returned the LastEvaluatedKey from that doubled batch as the cursor.
  // Effect: when many rows matched, items beyond position `limit` were
  // dropped and the cursor jumped over them — entire conversations
  // silently invisible to the admin. We now pull Limit=limit per round
  // and only loop to top up after filter rejections.
  while (items.length < limit && !exhausted) {
    const response = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: BY_CREATED_AT,
        KeyConditionExpression: 'listPk = :pk',
        ExpressionAttributeValues: {
          ':pk': CHAT_LIST_PK
        },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey
      })
    )
    const batch = (response.Items || []).map(normalizeChatItem)
    for (const item of batch) {
      if (!chatItemMatchesFilters(item, filters)) continue
      items.push({
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        promptVersion: item.promptVersion,
        reviewed: item.reviewed,
        flagged: item.flagged,
        flags: item.flags,
        turnCount: item.turnCount,
        model: item.model,
        provider: item.provider,
        lastUserMessage: item.lastUserMessage,
        // Voice indicators for the list view — keep small so the row stays
        // light. Full breakdown lives on the detail endpoint.
        modality: item.modality,
        voiceTurnCount: item.voiceTurnCount,
        textTurnCount: item.textTurnCount,
        totalToolCalls: item.totalToolCalls,
        totalVoiceDurationMs: item.totalVoiceDurationMs,
        transports: item.transports
      })
    }
    startKey = response.LastEvaluatedKey
    if (!startKey) exhausted = true
  }

  // We may have overshot by up to `limit-1` items if the last batch filled the
  // remaining slack. Slice; build the cursor from the LAST item we KEPT so
  // the next page resumes exactly where we stopped. Using response.LastEvaluatedKey
  // here would skip the items we collected-but-didn't-return.
  let returnedItems = items
  let returnedCursor = ''
  if (items.length > limit) {
    returnedItems = items.slice(0, limit)
    const lastKept = returnedItems[returnedItems.length - 1]
    returnedCursor = encodeCursor({
      listPk: CHAT_LIST_PK,
      createdAt: lastKept.createdAt,
      id: lastKept.id
    })
  } else if (items.length === limit && !exhausted) {
    // Filled exactly; LastEvaluatedKey points to the next unread row.
    returnedCursor = encodeCursor(startKey)
  }
  // exhausted (no more data) → empty cursor.

  return {
    items: returnedItems,
    nextCursor: returnedCursor
  }
}

async function getChatTranscript(id) {
  const response = await ddb.send(
    new GetCommand({
      TableName: chatTableName(),
      Key: { id }
    })
  )
  return response.Item ? normalizeChatItem(response.Item) : null
}

async function updateChatNote(id, note) {
  await ddb.send(
    new UpdateCommand({
      TableName: chatTableName(),
      Key: { id },
      UpdateExpression: 'SET adminNotes = :note, updatedAt = :updatedAt',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: {
        ':note': String(note || '').trim(),
        ':updatedAt': new Date().toISOString()
      }
    })
  )
}

async function updateChatReviewed(id, reviewed) {
  await ddb.send(
    new UpdateCommand({
      TableName: chatTableName(),
      Key: { id },
      UpdateExpression: 'SET reviewed = :reviewed, updatedAt = :updatedAt',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: {
        ':reviewed': Boolean(reviewed),
        ':updatedAt': new Date().toISOString()
      }
    })
  )
}

async function getChatSummary() {
  const summary = {
    total: 0,
    reviewed: 0,
    unreviewed: 0,
    flagged: 0,
    byPromptVersion: {},
    byFlag: CHAT_FLAGS.reduce((acc, name) => {
      acc[name] = 0
      return acc
    }, {}),
    // Voice telemetry roll-up across every transcript in the table. Computed
    // from per-turn fields (modality/turnDurationMs/audio*/toolCalls) so it
    // stays accurate as the FE adds more metrics — no separate aggregate
    // table to keep in sync.
    voice: {
      sessions: 0,                 // any conversation with >=1 voice turn
      textOnlySessions: 0,
      mixedSessions: 0,
      voiceTurns: 0,
      textTurns: 0,
      toolCalls: 0,
      toolHistogram: {},
      transports: {},
      interruptedTurns: 0,
      audioInBytes: 0,
      audioOutBytes: 0,
      totalVoiceDurationMs: 0,
      avgVoiceTurnDurationMs: 0,
      avgTextLatencyMs: 0,
      _textLatencySumMs: 0,
      _textLatencySamples: 0
    },
    // Activity by UTC day (last 30) — sparkline data for the dashboard. We
    // pull updatedAt (when the most recent turn landed) so a long-running
    // session shows up on the day it was last touched.
    activityByDay: {},
    activeDays: 0
  }

  // Pull only the fields the summary needs. Keep ProjectionExpression tight
  // so a 50k-row table doesn't OOM the Lambda. `turns` is the big one but
  // is required for the per-turn modality/transport/tool rollups.
  let startKey
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: chatTableName(),
        FilterExpression: 'listPk = :pk',
        ExpressionAttributeValues: {
          ':pk': CHAT_LIST_PK
        },
        ProjectionExpression: 'id, reviewed, promptVersion, #flags, flagged, updatedAt, createdAt, turns',
        ExpressionAttributeNames: {
          '#flags': 'flags'
        },
        ExclusiveStartKey: startKey
      })
    )
    const items = response.Items || []
    for (const rawItem of items) {
      const item = normalizeChatItem(rawItem)
      summary.total += 1
      if (item.reviewed) summary.reviewed += 1
      else summary.unreviewed += 1
      if (item.flagged) summary.flagged += 1

      const version = item.promptVersion || 'unknown'
      summary.byPromptVersion[version] = (summary.byPromptVersion[version] || 0) + 1
      for (const flag of CHAT_FLAGS) {
        if (item.flags?.[flag]) summary.byFlag[flag] += 1
      }

      // Voice rollup
      if (item.voiceTurnCount > 0) summary.voice.sessions += 1
      else summary.voice.textOnlySessions += 1
      if (item.voiceTurnCount > 0 && item.textTurnCount > 0) summary.voice.mixedSessions += 1
      summary.voice.voiceTurns += item.voiceTurnCount
      summary.voice.textTurns += item.textTurnCount
      summary.voice.toolCalls += item.totalToolCalls
      summary.voice.interruptedTurns += item.interruptedTurns
      summary.voice.audioInBytes += item.totalAudioInBytes
      summary.voice.audioOutBytes += item.totalAudioOutBytes
      summary.voice.totalVoiceDurationMs += item.totalVoiceDurationMs
      summary.voice._textLatencySumMs += item.textLatencySumMs
      summary.voice._textLatencySamples += item.textLatencySamples
      for (const [name, n] of Object.entries(item.toolHistogram || {})) {
        summary.voice.toolHistogram[name] = (summary.voice.toolHistogram[name] || 0) + n
      }
      for (const [t, n] of Object.entries(item.transports || {})) {
        summary.voice.transports[t] = (summary.voice.transports[t] || 0) + n
      }

      // Activity bucket (UTC day, YYYY-MM-DD). Falls back to createdAt.
      const dayStamp = String(item.updatedAt || item.createdAt || '').slice(0, 10)
      if (dayStamp) {
        summary.activityByDay[dayStamp] = (summary.activityByDay[dayStamp] || 0) + 1
      }
    }
    startKey = response.LastEvaluatedKey
  } while (startKey)

  if (summary.voice.voiceTurns > 0) {
    summary.voice.avgVoiceTurnDurationMs = Math.round(
      summary.voice.totalVoiceDurationMs / summary.voice.voiceTurns
    )
  }
  if (summary.voice._textLatencySamples > 0) {
    summary.voice.avgTextLatencyMs = Math.round(
      summary.voice._textLatencySumMs / summary.voice._textLatencySamples
    )
  }
  // Strip the private accumulators before responding.
  delete summary.voice._textLatencySumMs
  delete summary.voice._textLatencySamples

  summary.activeDays = Object.keys(summary.activityByDay).length

  return summary
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

async function suppressReport(id) {
  const message = await getMessage(id)
  if (!message) return { notFound: true }
  if (message.status === 'sent') return { invalid: true, reason: 'already_sent' }

  await ddb.send(
    new UpdateCommand({
      TableName: process.env.CONTACT_MESSAGES_TABLE,
      Key: { id },
      UpdateExpression: 'SET #rs = :true',
      ExpressionAttributeNames: { '#rs': 'reportSuppressed' },
      ExpressionAttributeValues: {
        ':true': true
      }
    })
  )

  return { ok: true }
}

export const handler = async (event) => {
  const origin = resolveCorsOrigin(event)
  const json = (statusCode, obj) => jsonBase(statusCode, obj, origin)
  const unauthorized = () => unauthorizedBase(origin)

  const method = getMethod(event)
  if (method === 'OPTIONS') return optionsResponse(origin)
  if (!requireAdminKey(event)) return unauthorized()

  const path = getPath(event)

  if (path.startsWith('/api/chat/admin/')) {
    if (!hasChatTranscriptTable()) {
      return json(503, { error: 'Chat transcript table is not configured' })
    }

    if (method === 'GET' && path.endsWith('/transcripts/summary')) {
      return json(200, await getChatSummary())
    }

    if (method === 'GET' && path.endsWith('/transcripts')) {
      const limit = parseLimit(event)
      const cursor = event?.queryStringParameters?.cursor || ''
      const filters = parseChatFilters(event)
      const { items, nextCursor } = await listChatTranscripts(limit, cursor, filters)
      return json(200, { items, nextCursor })
    }

    if (method === 'GET') {
      const detailMatch = path.match(/\/transcripts\/([^/]+)$/)
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1])
        const item = await getChatTranscript(id)
        if (!item) return json(404, { error: 'Transcript not found' })
        return json(200, item)
      }
    }

    if (method === 'POST') {
      const noteMatch = path.match(/\/transcripts\/([^/]+)\/note$/)
      if (noteMatch) {
        const id = decodeURIComponent(noteMatch[1])
        const body = parseBody(event)
        const note = String(body?.note || '').trim().slice(0, 4000)
        try {
          await updateChatNote(id, note)
          return json(200, { ok: true, id, adminNotes: note })
        } catch (error) {
          if (error?.name === 'ConditionalCheckFailedException') {
            return json(404, { error: 'Transcript not found' })
          }
          throw error
        }
      }

      const reviewedMatch = path.match(/\/transcripts\/([^/]+)\/reviewed$/)
      if (reviewedMatch) {
        const id = decodeURIComponent(reviewedMatch[1])
        const body = parseBody(event)
        const reviewed = body?.reviewed !== false
        try {
          await updateChatReviewed(id, reviewed)
          return json(200, { ok: true, id, reviewed })
        } catch (error) {
          if (error?.name === 'ConditionalCheckFailedException') {
            return json(404, { error: 'Transcript not found' })
          }
          throw error
        }
      }
    }
  }

  if (method === 'POST' && /\/messages\/[^/]+\/suppress-report/.test(path)) {
    const m = path.match(/\/messages\/([^/]+)\/suppress-report/)
    const id = m?.[1]
    if (!id) return json(400, { error: 'Invalid path' })
    const result = await suppressReport(id)
    if (result.notFound) return json(404, { error: 'Message not found' })
    if (result.invalid) {
      return json(400, { error: 'Cannot suppress report for a sent message' })
    }
    return json(200, { ok: true, reportSuppressed: true })
  }

  if (method === 'GET' && path.endsWith('/summary')) {
    return json(200, await getSummary())
  }

  if (method === 'GET' && path.endsWith('/messages')) {
    const limit = parseLimit(event)
    const cursor = event?.queryStringParameters?.cursor || ''
    const { items, nextCursor } = await listMessages(limit, cursor)
    return json(200, { items, nextCursor })
  }

  if (method === 'GET' && path.endsWith('/health')) {
    return json(200, await getHealth())
  }

  if (method === 'GET') {
    const detailMatch = path.match(/\/messages\/([^/]+)$/)
    if (detailMatch) {
      const id = detailMatch[1]
      const item = await getMessage(id)
      if (!item) return json(404, { error: 'Message not found' })
      return json(200, item)
    }
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
