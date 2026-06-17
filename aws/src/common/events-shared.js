import {
  clampLen,
  getClientIp,
  getUserAgent,
  hashIp,
  makeId,
  nowIso,
  safeTrim
} from './contact-shared.js'

// First-party site-interaction events. Each event is a durable row mirroring the
// contact/chat convention: a unique `id` HASH key plus `listPk: 'EVENT'` +
// `createdAt` for the shared byCreatedAt GSI (so a day can be range-queried).
export const EVENT_LIST_PK = 'EVENT'

// Hard caps so a single request can never write an unbounded number of rows or
// store oversized blobs. The frontend batches small flushes; anything beyond
// this is almost certainly abuse.
const MAX_EVENTS_PER_BATCH = 100
const MAX_EVENT_NAME_LEN = 80
const MAX_PARAM_VALUE_LEN = 240
const MAX_PARAMS = 24
const MAX_PAGE_LEN = 300

// Raw events self-expire via DynamoDB TTL. Aggregated daily reports are the
// durable record; the raw rows are only needed long enough to build them and to
// spot-check, so 120 days is generous headroom.
const EVENT_TTL_DAYS = 120

function clampParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(params)) {
    if (count >= MAX_PARAMS) break
    const k = clampLen(key, 60)
    if (!k) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[k] = value
    } else {
      out[k] = clampLen(String(value), MAX_PARAM_VALUE_LEN)
    }
    count += 1
  }
  return out
}

export function buildEventRecord(payload, headers = {}, batchSessionId = '') {
  const event = clampLen(payload?.event, MAX_EVENT_NAME_LEN)
  const sessionId = clampLen(payload?.sessionId || batchSessionId, 80)
  const page = clampLen(payload?.page, MAX_PAGE_LEN)
  const section = clampLen(payload?.section, 60)
  const params = clampParams(payload?.params)
  const userAgent = clampLen(getUserAgent(headers), 240)
  // x-forwarded-for is "client, proxy1, proxy2"; the leftmost entry is the real
  // visitor. Hash only that so one visitor counts once regardless of proxy chain.
  const clientIp = safeTrim(String(getClientIp(headers)).split(',')[0])
  const ipHash = hashIp(clientIp)
  const ttl = Math.floor(Date.now() / 1000) + EVENT_TTL_DAYS * 24 * 60 * 60

  return {
    id: makeId(),
    listPk: EVENT_LIST_PK,
    createdAt: nowIso(),
    event,
    sessionId,
    page,
    section,
    params,
    userAgent,
    ipHash,
    ttl
  }
}

// Turn a raw `{ sessionId, events: [...] }` request body into validated rows:
// drop events with no name, inherit the batch sessionId, and clamp the count.
export function normalizeEventBatch(body, headers = {}) {
  const batchSessionId = safeTrim(body?.sessionId)
  const events = Array.isArray(body?.events) ? body.events : []
  const rows = []
  for (const raw of events) {
    if (rows.length >= MAX_EVENTS_PER_BATCH) break
    if (!safeTrim(raw?.event)) continue
    rows.push(buildEventRecord(raw, headers, batchSessionId))
  }
  return rows
}

// Inclusive start / exclusive end ISO timestamps for a UTC calendar day.
export function utcDayBounds(day) {
  const start = new Date(`${day}T00:00:00.000Z`)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

// The UTC calendar day (YYYY-MM-DD) immediately before `ref` (defaults to now).
export function previousUtcDay(ref = new Date()) {
  const d = new Date(ref.getTime() - 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}
