export async function sendViaResend({
  apiKey,
  from,
  to,
  subject,
  text,
  replyTo
}) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = body?.message || body?.error || `Resend error (${res.status})`
    const e = new Error(err)
    e.status = res.status
    e.body = body
    throw e
  }
  return body
}

