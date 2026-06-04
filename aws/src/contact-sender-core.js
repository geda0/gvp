import { formatText } from './common/contact-shared.js'

export function createSenderHandler({ store, sendEmail, env = process.env }) {
  return async (event) => {
    for (const sqsRecord of event.Records || []) {
      const { id } = JSON.parse(sqsRecord.body)
      const row = await store.loadMessage(id)
      if (!row || row.status === 'sent') continue
      const attempts = (row.attempts || 0) + 1
      await store.markSending(id, attempts)

      const subject = row.subject ? `[Contact] ${row.subject}` : '[Contact] New message'
      try {
        const info = await sendEmail({
          apiKey: env.RESEND_API_KEY,
          from: env.CONTACT_FROM_EMAIL,
          to: env.CONTACT_TO_EMAIL,
          subject,
          text: formatText(row),
          replyTo: row.email
        })
        await store.markSent(id, attempts, info?.id || null)
      } catch (error) {
        const errorMessage = String(error?.message || error)
        console.error('Failed to send contact message', { id, attempts, errorMessage })
        await store.markFailed(id, attempts, errorMessage)
        throw error
      }
    }
  }
}
