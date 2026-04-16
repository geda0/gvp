export async function sendViaResend({
  apiKey,
  from,
  to,
  subject,
  text,
  replyTo
}) {
  const response = await fetch('https://api.resend.com/emails', {
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

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `Resend error (${response.status})`)
    error.status = response.status
    error.body = body
    throw error
  }

  return body
}
