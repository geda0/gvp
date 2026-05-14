const REQUEST_TIMEOUT_MS = 10000

async function postOnce({ apiKey, payload }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function sendViaResend({
  apiKey,
  from,
  to,
  subject,
  text,
  replyTo
}) {
  const payload = {
    from,
    to,
    subject,
    text,
    ...(replyTo ? { reply_to: replyTo } : {})
  }

  // One bounded retry on network error (incl. timeout/abort) or 5xx.
  // 4xx responses are deterministic failures and are not retried.
  let response
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await postOnce({ apiKey, payload })
    } catch (networkError) {
      if (attempt === 0) continue
      throw networkError
    }
    if (response.status >= 500 && attempt === 0) continue
    break
  }

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `Resend error (${response.status})`)
    error.status = response.status
    error.body = body
    throw error
  }

  return body
}
