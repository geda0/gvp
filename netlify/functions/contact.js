import { getContactStore, nowIso, safeTrim, makeId, hashIp, msgKey } from './_contact-store.js'
import { sendViaResend } from './_resend.js'

function json(statusCode, obj) {
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' }
  })
}

function getClientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for') ||
    ''
  )
}

function validateEmail(email) {
  const e = safeTrim(email)
  if (!e) return false
  if (e.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

function clampLen(s, max) {
  const v = safeTrim(s)
  return v.length > max ? v.slice(0, max) : v
}

function formatText(record) {
  const lines = [
    `New contact message (${record.id})`,
    '',
    `From: ${record.name || '—'} <${record.email}>`,
    `Subject: ${record.subject || '—'}`,
    `Time: ${record.createdAt}`,
    '',
    record.message
  ]
  return lines.join('\n')
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  let payload
  try {
    payload = await req.json()
  } catch (_) {
    return json(400, { error: 'Invalid JSON' })
  }

  // Honeypot
  if (safeTrim(payload?.company)) {
    // Always act successful to bots.
    return json(200, { ok: true, persisted: true, delivery: 'queued' })
  }

  const name = clampLen(payload?.name, 120)
  const email = clampLen(payload?.email, 254)
  const subject = clampLen(payload?.subject, 180)
  const message = clampLen(payload?.message, 4000)

  if (!validateEmail(email) || !message) {
    return json(400, { error: 'Please provide a valid email and a message.' })
  }

  const apiKey = process.env.RESEND_API_KEY
  const to = process.env.CONTACT_TO_EMAIL
  const from = process.env.CONTACT_FROM_EMAIL

  if (!apiKey || !to || !from) {
    return json(500, { error: 'Contact service is not configured.' })
  }

  const store = getContactStore()
  const id = makeId()
  const createdAt = nowIso()
  const ipHash = hashIp(getClientIp(req))
  const ua = clampLen(req.headers.get('user-agent'), 240)

  const record = {
    id,
    createdAt,
    name,
    email,
    subject,
    message,
    userAgent: ua,
    ipHash,
    status: 'pending',
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    resendId: null
  }

  // Persist first (durable). Only return success after this succeeds.
  await store.set(msgKey(id), JSON.stringify(record))

  // Attempt immediate delivery. If it fails, keep pending; retries will handle it.
  try {
    const resendSubject = subject ? `[Contact] ${subject}` : '[Contact] New message'
    const info = await sendViaResend({
      apiKey,
      from,
      to,
      subject: resendSubject,
      text: formatText(record),
      replyTo: email
    })

    record.status = 'delivered'
    record.attempts = 1
    record.deliveredAt = nowIso()
    record.resendId = info?.id || null
    await store.set(msgKey(id), JSON.stringify(record))

    return json(200, { ok: true, persisted: true, delivery: 'delivered', id })
  } catch (e) {
    record.status = 'pending'
    record.attempts = 1
    record.lastError = String(e?.message || e)
    await store.set(msgKey(id), JSON.stringify(record))

    // Saved successfully, delivery queued for retries.
    return json(200, { ok: true, persisted: true, delivery: 'queued', id })
  }
}

