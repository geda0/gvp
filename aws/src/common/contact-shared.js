import crypto from 'crypto'

export function safeTrim(value) {
  return String(value || '').trim()
}

export function clampLen(value, max) {
  const trimmed = safeTrim(value)
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export function validateEmail(email) {
  const normalized = safeTrim(email)
  if (!normalized) return false
  if (normalized.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
}

export function nowIso() {
  return new Date().toISOString()
}

export function makeId() {
  return crypto.randomUUID()
}

export function hashIp(ip) {
  const value = safeTrim(ip)
  if (!value) return ''
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function getClientIp(headers = {}) {
  return (
    headers['x-forwarded-for'] ||
    headers['X-Forwarded-For'] ||
    headers['x-real-ip'] ||
    headers['X-Real-Ip'] ||
    ''
  )
}

export function getUserAgent(headers = {}) {
  return headers['user-agent'] || headers['User-Agent'] || ''
}

export function parseJsonBody(event) {
  if (!event?.body) return {}
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body
  return JSON.parse(body)
}

export function buildMessageRecord(payload, headers = {}) {
  const id = makeId()
  const createdAt = nowIso()
  const name = clampLen(payload?.name, 120)
  const email = clampLen(payload?.email, 254)
  const subject = clampLen(payload?.subject, 180)
  const message = clampLen(payload?.message, 4000)
  const company = clampLen(payload?.company, 120)
  const userAgent = clampLen(getUserAgent(headers), 240)
  const ipHash = hashIp(getClientIp(headers))
  const normalizedMessage = {
    id,
    createdAt,
    listPk: 'CONTACT',
    name,
    email,
    subject,
    message,
    company,
    userAgent,
    ipHash,
    status: 'queued',
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    resendId: null
  }

  const idempotencyKey = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        email,
        subject,
        message,
        createdAtMinute: createdAt.slice(0, 16)
      })
    )
    .digest('hex')

  return { ...normalizedMessage, idempotencyKey }
}

export function validateMessage(record) {
  if (!validateEmail(record.email) || !record.message) {
    return 'Please provide a valid email and a message.'
  }
  return null
}

export function formatText(record) {
  return [
    `New contact message (${record.id})`,
    '',
    `From: ${record.name || '—'} <${record.email}>`,
    `Subject: ${record.subject || '—'}`,
    `Time: ${record.createdAt}`,
    '',
    record.message
  ].join('\n')
}

export function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,x-admin-key',
      'Access-Control-Allow-Methods': 'OPTIONS,GET,POST'
    },
    body: JSON.stringify(obj)
  }
}

export function optionsResponse() {
  return {
    statusCode: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,x-admin-key',
      'Access-Control-Allow-Methods': 'OPTIONS,GET,POST'
    }
  }
}

export function unauthorized() {
  return json(401, { error: 'Unauthorized' })
}
