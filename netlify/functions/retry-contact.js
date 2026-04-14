import { getContactStore, listMessages, loadMeta, saveMeta, msgKey, nowIso } from './_contact-store.js'
import { sendViaResend } from './_resend.js'

function plain(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
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

function formatReport(pending) {
  const lines = [
    'Contact delivery report',
    '',
    `Time: ${new Date().toISOString()}`,
    '',
    'Pending messages:',
    ...pending.map((p) => `- ${p.id} | attempts=${p.attempts} | lastError=${p.lastError || '—'}`)
  ]
  return lines.join('\n')
}

/**
 * Scheduled contact retries (cron in root `netlify.toml`).
 * Uses default `export default` + `Response` so Netlify injects Blobs context (v2 runtime).
 * Legacy `{ statusCode, body }` handlers can throw MissingBlobsEnvironmentError for `getStore()`.
 */
export default async function retryContact() {
  const apiKey = process.env.RESEND_API_KEY
  const to = process.env.CONTACT_TO_EMAIL
  const from = process.env.CONTACT_FROM_EMAIL

  if (!apiKey || !to || !from) {
    return plain('Not configured', 200)
  }

  const store = getContactStore()
  const blobs = await listMessages(store)
  if (!blobs.length) return plain('No messages', 200)

  const pending = []
  for (const b of blobs) {
    const rec = await store.get(b.key, { type: 'json' })
    if (!rec) continue
    if (rec.status === 'delivered') continue
    pending.push(rec)
  }

  const batch = pending
    .sort((a, b) => (a.attempts || 0) - (b.attempts || 0))
    .slice(0, 15)

  for (const rec of batch) {
    try {
      const resendSubject = rec.subject ? `[Contact] ${rec.subject}` : '[Contact] New message'
      const info = await sendViaResend({
        apiKey,
        from,
        to,
        subject: resendSubject,
        text: formatText(rec),
        replyTo: rec.email
      })
      rec.status = 'delivered'
      rec.deliveredAt = nowIso()
      rec.resendId = info?.id || rec.resendId || null
      rec.attempts = (rec.attempts || 0) + 1
      rec.lastError = null
      await store.set(msgKey(rec.id), JSON.stringify(rec))
    } catch (e) {
      rec.status = 'pending'
      rec.attempts = (rec.attempts || 0) + 1
      rec.lastError = String(e?.message || e)
      await store.set(msgKey(rec.id), JSON.stringify(rec))
    }
  }

  const stillPending = []
  for (const rec of pending) {
    const key = msgKey(rec.id)
    const fresh = await store.get(key, { type: 'json' })
    if (fresh && fresh.status !== 'delivered') stillPending.push(fresh)
  }

  const needsReport = stillPending.some((r) => (r.attempts || 0) >= 3)
  if (needsReport) {
    const meta = await loadMeta(store)
    const last = meta?.lastReportAt ? Date.parse(meta.lastReportAt) : 0
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    if (!last || now - last > dayMs) {
      await sendViaResend({
        apiKey,
        from,
        to,
        subject: '[Contact] Delivery report',
        text: formatReport(stillPending),
        replyTo: null
      })
      await saveMeta(store, { ...(meta || {}), lastReportAt: new Date().toISOString() })
    }
  }

  return plain('OK', 200)
}
