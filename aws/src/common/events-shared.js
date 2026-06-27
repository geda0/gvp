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
const MAX_EVENTS_PER_BATCH = 25
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
  const ipHash = hashIp(clientIp, process.env.IP_HASH_PEPPER)
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
    ttl,
    // Client-side interaction time (ms epoch). Preserved so a per-session timeline can
    // order events within a single beacon batch (which all share one server createdAt).
    // Conditional so an absent ts is never written as an undefined attribute.
    ...(Number.isFinite(payload?.ts) ? { ts: payload.ts } : {})
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

// The UTC calendar day (YYYY-MM-DD) immediately before `ref` (defaults to now).
export function previousUtcDay(ref = new Date()) {
  const d = new Date(ref.getTime() - 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

// ── Owner-local-timezone day helpers (ADR-0013) ──────────────────────────────
// The daily report buckets by the owner's local calendar day (REPORT_TZ), not
// UTC, so the email/report and the local-time admin dashboard agree at the day
// boundary. `en-CA` renders dates in ISO YYYY-MM-DD order; Intl + timeZone is
// DST-correct on the nodejs22 runtime (ICU built in).

// The YYYY-MM-DD of instant `ts` in `tz`. Falls back to the leading 10 chars when
// `ts` is unparseable (mirrors the utcDayOf fallback contract).
export function localDayOf(ts, tz) {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) return String(ts).slice(0, 10)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms))
}

// The local calendar day in `tz` immediately before `now` — the report's default
// target day.
export function previousLocalDay(tz, now = new Date()) {
  const today = localDayOf(now.toISOString(), tz)
  // Step back one full day from today's local midnight (24h is always < the gap
  // between two local calendar days, even across a DST transition).
  return localDayOf(new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 60 * 60 * 1000).toISOString(), tz)
}

// The UTC `day` to pass to queryDay (with lookbackDays: 1) so the fetched window
// is a SUPERSET of the local day `localDay` under any offset / DST: it is the next
// calendar day, giving the window [localDay 00:00Z, localDay+1 23:59:59.999Z].
export function utcWindowDayForLocal(localDay) {
  return new Date(Date.parse(`${localDay}T00:00:00Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
}
