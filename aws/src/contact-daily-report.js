import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { sendViaResend } from './common/resend.js'
import { buildDailyReport, renderReportHtml, renderReportText } from './common/daily-report.js'
import { previousUtcDay } from './common/events-shared.js'
import { queryDay } from './common/report-queries.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

// Scheduled daily. Aggregates the previous full UTC day across every backend we
// own — first-party site events, chat transcripts, contact submissions — into one
// structured report, then emails a sleek HTML digest (plain-text fallback).
export const handler = async (event) => {
  // Allow a manual/back-fill invocation with { date: 'YYYY-MM-DD' }.
  const day = (event && event.date) || previousUtcDay()

  const [events, chatSessions, contactMessages] = await Promise.all([
    queryDay(ddb, { tableName: process.env.SITE_EVENTS_TABLE, listPk: 'EVENT', day }),
    // lookbackDays:1 — chat rows freeze createdAt at the first turn, so a session
    // started just before midnight must be fetched here; aggregateChat({day}) then
    // counts only the turns whose own capturedAt falls on `day`.
    queryDay(ddb, { tableName: process.env.CHAT_TRANSCRIPTS_TABLE, listPk: 'CHAT_TRANSCRIPT', day, lookbackDays: 1 }),
    queryDay(ddb, { tableName: process.env.CONTACT_MESSAGES_TABLE, listPk: 'CONTACT', day })
  ])

  const report = buildDailyReport({ day, events, chatSessions, contactMessages })

  await sendViaResend({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.CONTACT_FROM_EMAIL,
    to: process.env.CONTACT_REPORT_EMAIL || process.env.CONTACT_TO_EMAIL,
    subject: `[Daily report] ${day} — ${report.site.totalEvents} interactions, ${report.chat.turns} chat turns, ${report.contact.submissions} contacts`,
    html: renderReportHtml(report),
    text: renderReportText(report),
    replyTo: null
  })

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      date: day,
      events: events.length,
      chatSessions: chatSessions.length,
      contactMessages: contactMessages.length
    })
  }
}
