import {
  json,
  optionsResponse,
  parseJsonBody,
  resolveCorsOrigin
} from './common/contact-shared.js'
import { normalizeEventBatch } from './common/events-shared.js'

// First-party analytics ingress. Fire-and-forget by design: the browser beacons
// a small batch of interaction events; we validate, clamp, and persist them, and
// answer 202 Accepted. There is no honeypot and nothing user-facing depends on
// the response, so failures are reported honestly (500) but never thrown.
export function createEventsHandler({ persistEvents, env = process.env }) {
  return async (event) => {
    const origin = resolveCorsOrigin(event)
    const method = event?.requestContext?.http?.method || event?.httpMethod || 'POST'
    if (method === 'OPTIONS') return optionsResponse(origin)
    if (method !== 'POST') return json(405, { error: 'Method not allowed' }, origin)

    let body
    try {
      body = parseJsonBody(event)
    } catch {
      return json(400, { error: 'Invalid JSON' }, origin)
    }

    if (!env.SITE_EVENTS_TABLE) {
      return json(500, { error: 'Events service is not configured.' }, origin)
    }

    const rows = normalizeEventBatch(body, event.headers || {})
    if (!rows.length) {
      return json(202, { ok: true, accepted: 0 }, origin)
    }

    try {
      await persistEvents(rows)
    } catch (error) {
      console.error('Failed to persist site events', {
        errorMessage: String(error?.message || error),
        count: rows.length
      })
      return json(500, { error: 'Events could not be recorded.' }, origin)
    }

    return json(202, { ok: true, accepted: rows.length }, origin)
  }
}

// Persist event rows in <=25-item BatchWrite chunks (DynamoDB's per-request cap),
// DRAINING UnprocessedItems with bounded backoff. BatchWrite returns 200 while
// listing items it declined under throttling; without this they would be silently
// dropped while the handler reported a false `accepted`. After maxAttempts of a
// chunk still having unprocessed items, THROW so the handler answers 500 rather
// than claiming success. `batchWrite(requestItems)` is injected (SDK lives in the
// thin Lambda wrapper) so this stays unit-testable.
const BATCH_LIMIT = 25
export async function persistEventRows({
  batchWrite,
  tableName,
  rows,
  maxAttempts = 5,
  baseDelayMs = 50,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  for (let i = 0; i < rows.length; i += BATCH_LIMIT) {
    let pending = rows.slice(i, i + BATCH_LIMIT).map((Item) => ({ PutRequest: { Item } }))
    for (let attempt = 1; ; attempt++) {
      const res = await batchWrite({ [tableName]: pending })
      const unprocessed = (res && res.UnprocessedItems && res.UnprocessedItems[tableName]) || []
      if (unprocessed.length === 0) break
      if (attempt >= maxAttempts) {
        throw new Error(
          `BatchWrite left ${unprocessed.length} item(s) unprocessed after ${maxAttempts} attempts`
        )
      }
      pending = unprocessed
      await sleep(baseDelayMs * attempt)
    }
  }
}
