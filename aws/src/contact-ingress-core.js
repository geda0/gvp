import {
  buildMessageRecord,
  json,
  optionsResponse,
  parseJsonBody,
  resolveCorsOrigin,
  validateMessage
} from './common/contact-shared.js'

export function createIngressHandler({ persistMessage, enqueueDelivery, env = process.env }) {
  return async (event) => {
    const origin = resolveCorsOrigin(event)
    const method = event?.requestContext?.http?.method || event?.httpMethod || 'POST'
    if (method === 'OPTIONS') return optionsResponse(origin)
    if (method !== 'POST') return json(405, { error: 'Method not allowed' }, origin)
    let payload
    try {
      payload = parseJsonBody(event)
    } catch {
      return json(400, { error: 'Invalid JSON' }, origin)
    }
    const record = buildMessageRecord(payload, event.headers || {})

    if (record.company) {
      return json(200, { ok: true, persisted: true, delivery: 'queued' }, origin)
    }

    const validationError = validateMessage(record)
    if (validationError) {
      return json(400, { error: validationError }, origin)
    }

    if (!env.CONTACT_MESSAGES_TABLE || !env.CONTACT_DELIVERY_QUEUE_URL) {
      return json(500, { error: 'Contact service is not configured.' }, origin)
    }

    try {
      await persistMessage(record)
      await enqueueDelivery({ id: record.id, idempotencyKey: record.idempotencyKey })
    } catch (error) {
      console.error('Failed to persist or enqueue contact message', {
        errorMessage: String(error?.message || error),
        recordId: record.id
      })
      return json(500, { error: 'Message could not be queued. Please try again.' }, origin)
    }

    return json(200, { ok: true, persisted: true, delivery: 'queued', id: record.id }, origin)
  }
}
