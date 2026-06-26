import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { sendViaResend } from './common/resend.js'
import { renderReportHtml, renderReportText } from './common/daily-report.js'
import { buildDailyReportForDay } from './common/daily-report-build.js'
import { queryDay } from './common/report-queries.js'
import { rollupSmoke, timedCheck } from './common/smoke-core.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

// A 1-row GSI query proves a table is reachable (returns even when empty); a throw
// (missing table / IAM / network) becomes a fail check via timedCheck.
async function probeTable(tableName, listPk) {
  if (!tableName) throw new Error('table not configured')
  await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'byCreatedAt',
      KeyConditionExpression: 'listPk = :pk',
      ExpressionAttributeValues: { ':pk': listPk },
      Limit: 1
    })
  )
  return 'reachable'
}

// Deep live-agent probe for the email: ask the chat host's admin-gated smoke endpoint
// to run a real Gemini Live probe. Off unless CHAT_SMOKE_URL is set and the kill-switch
// is not '0'. Timeout-guarded; any failure becomes a single fail check (never throws,
// never blocks the email).
async function fetchDeepChatChecks() {
  const url = (process.env.CHAT_SMOKE_URL || '').trim()
  if (!url || process.env.SMOKE_DEEP_IN_REPORT === '0') return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}deep=1&report=1`, {
      headers: { 'x-smoke-key': process.env.SMOKE_PROBE_KEY || '' },
      signal: controller.signal
    })
    const body = await res.json().catch(() => null)
    if (res.ok && body && Array.isArray(body.checks)) return body.checks
    return [{ name: 'chat_model_live', status: 'fail', latencyMs: 0, detail: `chat smoke HTTP ${res.status}`, cost: 'paid' }]
  } catch (error) {
    return [{ name: 'chat_model_live', status: 'fail', latencyMs: 0, detail: String((error && error.message) || error), cost: 'paid' }]
  } finally {
    clearTimeout(timer)
  }
}

// Real dependency + live-agent health for the email. Cheap table reachability always;
// the deep live probe when configured. Never throws.
async function computeReportSmoke() {
  try {
    const cheap = await Promise.all([
      timedCheck('contact_table', () => probeTable(process.env.CONTACT_MESSAGES_TABLE, 'CONTACT')),
      timedCheck('chat_table', () => probeTable(process.env.CHAT_TRANSCRIPTS_TABLE, 'CHAT_TRANSCRIPT')),
      timedCheck('events_table', () => probeTable(process.env.SITE_EVENTS_TABLE, 'EVENT'))
    ])
    const deep = await fetchDeepChatChecks()
    return rollupSmoke([...cheap, ...deep], deep.length ? 'deep' : 'cheap')
  } catch {
    return undefined
  }
}

// Scheduled daily. Aggregates the previous full UTC day across every backend we
// own — first-party site events, chat transcripts, contact submissions — into one
// structured report, then emails a sleek HTML digest (plain-text fallback).
export const handler = async (event) => {
  // The report's day is the owner's LOCAL calendar day (REPORT_TZ, default
  // America/Los_Angeles), not UTC, so the email and the local-time dashboard agree
  // on day attribution (ADR-0013). The shared builder widens the UTC query window
  // and the aggregators trim it per-row. Manual/back-fill: { date: 'YYYY-MM-DD' }
  // (interpreted as a local day).
  const smoke = await computeReportSmoke()
  const report = await buildDailyReportForDay((opts) => queryDay(ddb, opts), {
    tables: {
      events: process.env.SITE_EVENTS_TABLE,
      chat: process.env.CHAT_TRANSCRIPTS_TABLE,
      contact: process.env.CONTACT_MESSAGES_TABLE
    },
    day: event && event.date,
    smoke
  })
  const day = report.date

  await sendViaResend({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.CONTACT_FROM_EMAIL,
    to: process.env.CONTACT_REPORT_EMAIL || process.env.CONTACT_TO_EMAIL,
    subject: `[Daily report] ${day} — ${report.site.totalEvents} interactions, ${report.chat.turns} chat turns, ${report.contact.submissions} contacts`,
    html: renderReportHtml(report),
    text: renderReportText(report),
    replyTo: null,
    idempotencyKey: `daily-report-${day}`
  })

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      date: day,
      events: report.site.totalEvents,
      chatSessions: report.chat.sessions,
      contactMessages: report.contact.submissions
    })
  }
}
