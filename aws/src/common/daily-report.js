import { localDayOf } from './events-shared.js'

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function topN(counts, n) {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, n)
}

function aggregateSite(events, { day, tz } = {}) {
  // ADR-0013: the query window over-fetches neighbouring local days, so filter by
  // the owner-local day here (no-op when day is unset — used by callers that
  // pre-scope). totalEvents etc. then count only the report's day.
  const rows = day ? events.filter((e) => localDayOf(e?.createdAt, tz) === day) : events
  const byEventCounts = {}
  const bySectionCounts = {}
  const byPageCounts = {}
  const sessions = new Set()
  const visitors = new Set()

  for (const e of rows) {
    const name = e?.event || 'unknown'
    byEventCounts[name] = (byEventCounts[name] || 0) + 1
    if (e?.section) bySectionCounts[e.section] = (bySectionCounts[e.section] || 0) + 1
    if (e?.page) byPageCounts[e.page] = (byPageCounts[e.page] || 0) + 1
    if (e?.sessionId) sessions.add(e.sessionId)
    if (e?.ipHash) visitors.add(e.ipHash)
  }

  return {
    totalEvents: rows.length,
    sessions: sessions.size,
    uniqueVisitors: visitors.size,
    byEvent: Object.entries(byEventCounts)
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event)),
    bySection: topN(bySectionCounts, 12).map(({ key, count }) => ({ section: key, count })),
    topPages: topN(byPageCounts, 12).map(({ key, count }) => ({ page: key, count }))
  }
}

function aggregateChat(chatSessions, { day, tz } = {}) {
  let turns = 0
  let textTurns = 0
  let voiceTurns = 0
  let failures = 0
  let fallbacks = 0
  let toolCalls = 0
  let flaggedSessions = 0
  let activeSessions = 0
  const errorsByCode = {}
  let firstTokenSum = 0
  let firstTokenCount = 0

  for (const session of chatSessions) {
    const sessionTurns = Array.isArray(session?.turns) ? session.turns : []
    let sessionHasTurn = false
    for (const t of sessionTurns) {
      const ts = (typeof t?.capturedAt === 'string' && t.capturedAt) || session?.createdAt || ''
      if (day && localDayOf(ts, tz) !== day) continue
      sessionHasTurn = true
      turns += 1
      if (t?.modality === 'voice') voiceTurns += 1
      else textTurns += 1
      if (t?.status && t.status !== 'ok') {
        failures += 1
        const code = t.errorCode || t.status
        errorsByCode[code] = (errorsByCode[code] || 0) + 1
      }
      if (t?.fallbackUsed) fallbacks += 1
      if (Array.isArray(t?.toolCalls)) toolCalls += t.toolCalls.length
      if (t?.stream && t?.status === 'ok' && typeof t?.firstTokenLatencyMs === 'number') {
        firstTokenSum += t.firstTokenLatencyMs
        firstTokenCount += 1
      }
    }
    const isActive = day ? sessionHasTurn : true
    if (isActive) {
      activeSessions += 1
      if (session?.flagged) flaggedSessions += 1
    }
  }

  return {
    sessions: activeSessions,
    turns,
    textTurns,
    voiceTurns,
    failures,
    fallbacks,
    toolCalls,
    flaggedSessions,
    errorsByCode,
    avgFirstTokenMs: firstTokenCount ? Math.round(firstTokenSum / firstTokenCount) : undefined
  }
}

function aggregateContact(contactMessages, { day, tz } = {}) {
  const rows = day ? contactMessages.filter((m) => localDayOf(m?.createdAt, tz) === day) : contactMessages
  const byStatus = {}
  const senders = []
  for (const m of rows) {
    const status = m?.status || 'unknown'
    byStatus[status] = (byStatus[status] || 0) + 1
    senders.push({
      name: m?.name || '',
      email: m?.email || '',
      subject: m?.subject || '',
      status,
      createdAt: m?.createdAt || ''
    })
  }
  return {
    submissions: rows.length,
    sent: byStatus.sent || 0,
    failed: byStatus.failed || 0,
    queued: (byStatus.queued || 0) + (byStatus.sending || 0),
    byStatus,
    senders
  }
}

// ADR-0014: projects a live smoke object to only the deterministic categorical
// fields. Drops latencyMs, timestamps, and detail so the email body is stable
// across retries. Returns undefined when the input is absent or has no checks
// (so the renderer omits the card entirely).
export function stabilizeSmokeForReport(smoke) {
  if (!smoke || !Array.isArray(smoke.checks) || smoke.checks.length === 0) return undefined
  const result = { overall: smoke.overall }
  if (smoke.depth !== undefined) result.depth = smoke.depth
  result.checks = smoke.checks.map(({ name, status, cost }) => ({ name, status, cost }))
  return result
}

// ADR-0014: predicate for swallowing a Resend per-day idempotency 409 on retry.
export function isResendIdempotencyConflict(error) {
  return Boolean(error && error.status === 409 && error.body && error.body.name === 'invalid_idempotent_request')
}

// Pure aggregator: takes the day's already-fetched rows from each source and
// returns one structured report object. Shared by the scheduled email Lambda and
// the admin endpoint so the email and the board can never disagree.
export function buildDailyReport({ day, tz = 'UTC', events = [], chatSessions = [], contactMessages = [], smoke } = {}) {
  // ADR-0013: every aggregator buckets by the owner-local day (tz). tz defaults to
  // 'UTC' so an omitted tz reproduces the old UTC-day behavior (backward compatible).
  const site = aggregateSite(events, { day, tz })
  const chat = aggregateChat(chatSessions, { day, tz })
  const contact = aggregateContact(contactMessages, { day, tz })

  const highlights = [
    `${site.totalEvents} site interaction${site.totalEvents === 1 ? '' : 's'} across ${site.sessions} session${site.sessions === 1 ? '' : 's'}`,
    `${chat.turns} chat turn${chat.turns === 1 ? '' : 's'} (${chat.textTurns} text, ${chat.voiceTurns} voice)`,
    `${contact.submissions} contact submission${contact.submissions === 1 ? '' : 's'}`
  ]

  return {
    date: day,
    tz,
    generatedAt: day ? `${day}T00:00:00.000Z` : new Date().toISOString(),
    site,
    chat,
    contact,
    highlights,
    // Optional smoke-test result (dependency + live-agent health). Undefined when
    // the caller did not run a smoke pass; renderers omit the card in that case.
    smoke
  }
}

function barRows(items, labelKey, max) {
  if (!items.length) return '<tr><td colspan="2" class="muted">None</td></tr>'
  const peak = Math.max(...items.map((i) => i.count), 1)
  return items
    .slice(0, max)
    .map((i) => {
      const pct = Math.round((i.count / peak) * 100)
      return `<tr><td>${esc(i[labelKey])}</td><td class="bar"><span class="bar__fill" style="width:${pct}%"></span><b>${i.count}</b></td></tr>`
    })
    .join('')
}

function statCard(label, value, hint) {
  return `<td class="stat"><div class="stat__v">${esc(value)}</div><div class="stat__l">${esc(label)}</div>${hint ? `<div class="stat__h">${esc(hint)}</div>` : ''}</td>`
}

function smokePill(status) {
  return status === 'pass' ? 'sent' : status === 'fail' ? 'failed' : 'warn'
}

// Optional System-health card from a smoke-test result. Omitted entirely when no
// smoke was run. Every user/provider-derived field (check name + detail) is esc()'d.
function smokeCard(smoke) {
  if (!smoke) return ''
  const rows =
    (smoke.checks || [])
      .map(
        (c) =>
          `<tr><td>${esc(c.name)}</td><td><span class="pill pill--${smokePill(c.status)}">${esc(c.status)}</span></td><td>${esc(c.detail)}</td><td class="num">${c.latencyMs != null ? esc(c.latencyMs) + ' ms' : ''}${c.cost === 'paid' ? ' · paid' : ''}</td></tr>`
      )
      .join('') || '<tr><td colspan="4" class="muted">No checks</td></tr>'
  return `
  <div class="card">
    <h2>System health <span class="pill pill--${smokePill(smoke.overall)}">${esc(smoke.overall)}</span></h2>
    <table style="margin-top:6px"><thead><tr><td>Check</td><td>Status</td><td>Detail</td><td class="num">Latency</td></tr></thead><tbody>${rows}</tbody></table>
  </div>`
}

// Sleek, email-client-safe HTML (inline-ish styles, table layout). Self-contained
// document so it renders identically in an inbox and in the admin preview.
export function renderReportHtml(report) {
  const { site, chat, contact } = report
  const errorRows = topN(chat.errorsByCode, 8)
    .map((e) => `<tr><td>${esc(e.key)}</td><td class="num">${e.count}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="muted">No errors</td></tr>'
  const senderRows = contact.senders.length
    ? contact.senders
        .map(
          (s) =>
            `<tr><td>${esc(s.name || '—')}<div class="sub">${esc(s.email)}</div></td><td>${esc(s.subject || '—')}</td><td><span class="pill pill--${esc(s.status)}">${esc(s.status)}</span></td></tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="muted">No contact submissions</td></tr>'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily report — ${esc(report.date)}</title>
<style>
  body{margin:0;background:#0b1220;color:#e2e8f0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:680px;margin:0 auto;padding:24px}
  .head{padding:20px 24px;background:linear-gradient(135deg,#1d4ed8,#0f172a);border-radius:14px}
  .head h1{margin:0;font-size:20px;color:#f8fafc}
  .head p{margin:6px 0 0;color:#bfdbfe;font-size:13px}
  .card{background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:18px 20px;margin-top:16px}
  .card h2{margin:0 0 12px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8}
  table{width:100%;border-collapse:collapse}
  .stats td{padding:6px;text-align:center;width:25%}
  .stat{background:#111827;border:1px solid #1e293b;border-radius:10px}
  .stat__v{font-size:22px;font-weight:700;color:#f8fafc}
  .stat__l{font-size:11px;color:#94a3b8;margin-top:2px}
  .stat__h{font-size:10px;color:#64748b;margin-top:2px}
  td{padding:7px 8px;font-size:13px;border-bottom:1px solid #1e293b;color:#cbd5e1;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;color:#e2e8f0}
  .muted{color:#64748b}
  .sub{font-size:11px;color:#64748b}
  .bar{position:relative}
  .bar__fill{display:inline-block;height:8px;background:#3b82f6;border-radius:4px;margin-right:8px;vertical-align:middle;min-width:2px}
  .bar b{color:#e2e8f0;font-variant-numeric:tabular-nums}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#1e293b;color:#cbd5e1}
  .pill--sent{background:#052e16;color:#bbf7d0}
  .pill--failed{background:#450a0a;color:#fecaca}
  .pill--warn{background:#422006;color:#fde68a}
  .foot{color:#475569;font-size:11px;text-align:center;padding:16px}
</style></head>
<body><div class="wrap">
  <div class="head">
    <h1>Daily report — ${esc(report.date)}</h1>
    <p>${report.highlights.map((h) => esc(h)).join(' &middot; ')}</p>
  </div>
  ${smokeCard(report.smoke)}
  <div class="card">
    <h2>Site interactions</h2>
    <table class="stats"><tr>
      ${statCard('Interactions', site.totalEvents)}
      ${statCard('Sessions', site.sessions)}
      ${statCard('Unique visitors', site.uniqueVisitors)}
      ${statCard('Event types', site.byEvent.length)}
    </tr></table>
    <table style="margin-top:14px"><tbody>${barRows(site.byEvent.map((e) => ({ event: e.event, count: e.count })), 'event', 12)}</tbody></table>
  </div>

  <div class="card">
    <h2>Top pages &amp; sections</h2>
    <table><tbody>
      ${barRows(site.topPages, 'page', 6)}
      ${site.bySection.length ? barRows(site.bySection, 'section', 6) : ''}
    </tbody></table>
  </div>

  <div class="card">
    <h2>Chat agent</h2>
    <table class="stats"><tr>
      ${statCard('Sessions', chat.sessions)}
      ${statCard('Turns', chat.turns, `${chat.textTurns} text / ${chat.voiceTurns} voice`)}
      ${statCard('Failures', chat.failures, `${chat.fallbacks} fell back`)}
      ${statCard('Avg 1st token', chat.avgFirstTokenMs != null ? chat.avgFirstTokenMs + ' ms' : '—')}
    </tr></table>
    <table style="margin-top:14px"><thead><tr><td>Error code</td><td class="num">Turns</td></tr></thead><tbody>${errorRows}</tbody></table>
  </div>

  <div class="card">
    <h2>Contact submissions</h2>
    <table class="stats"><tr>
      ${statCard('Total', contact.submissions)}
      ${statCard('Sent', contact.sent)}
      ${statCard('Failed', contact.failed)}
      ${statCard('In flight', contact.queued)}
    </tr></table>
    <table style="margin-top:14px"><thead><tr><td>From</td><td>Subject</td><td>Status</td></tr></thead><tbody>${senderRows}</tbody></table>
  </div>

  <div class="foot">Generated ${esc(report.generatedAt)} &middot; covers ${esc(report.date)}${report.tz ? ` (${esc(report.tz)})` : ''}</div>
</div></body></html>`
}

// Plain-text fallback for email clients that strip HTML.
export function renderReportText(report) {
  const { site, chat, contact } = report
  const lines = [
    `Daily report — ${report.date}`,
    `Generated: ${report.generatedAt}`,
    ...(report.smoke
      ? ['', `HEALTH: ${String(report.smoke.overall).toUpperCase()}`,
          ...(report.smoke.checks || []).map(
            (c) => `  ${String(c.status).toUpperCase()} — ${c.name}${c.detail != null ? ': ' + c.detail : ''}${c.latencyMs != null ? ' (' + c.latencyMs + ' ms' + (c.cost === 'paid' ? ', paid' : '') + ')' : c.cost === 'paid' ? ' (paid)' : ''}`
          )]
      : []),
    '',
    'SITE',
    `  Interactions: ${site.totalEvents}`,
    `  Sessions: ${site.sessions}`,
    `  Unique visitors: ${site.uniqueVisitors}`,
    ...site.byEvent.slice(0, 12).map((e) => `    ${e.event}: ${e.count}`),
    '',
    'CHAT',
    `  Sessions: ${chat.sessions}`,
    `  Turns: ${chat.turns} (${chat.textTurns} text, ${chat.voiceTurns} voice)`,
    `  Failures: ${chat.failures} (${chat.fallbacks} fell back)`,
    `  Avg first token: ${chat.avgFirstTokenMs != null ? chat.avgFirstTokenMs + ' ms' : '—'}`,
    '',
    'CONTACT',
    `  Submissions: ${contact.submissions}`,
    `  Sent: ${contact.sent} · Failed: ${contact.failed} · In flight: ${contact.queued}`,
    ...contact.senders.map((s) => `    ${s.status.toUpperCase()} — ${s.name || '—'} <${s.email}> — ${s.subject || '—'}`)
  ]
  return lines.join('\n')
}
