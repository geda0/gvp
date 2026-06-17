import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDailyReport, renderReportHtml, renderReportText } from '../aws/src/common/daily-report.js'

function fixture() {
  const day = '2026-06-15'
  const events = [
    { event: 'page_view', sessionId: 'a', section: 'home', page: '/', ipHash: 'ip1', createdAt: `${day}T01:00:00.000Z` },
    { event: 'page_view', sessionId: 'b', section: 'portfolio', page: '/portfolio', ipHash: 'ip2', createdAt: `${day}T02:00:00.000Z` },
    { event: 'section_navigation', sessionId: 'a', section: 'portfolio', ipHash: 'ip1', createdAt: `${day}T01:01:00.000Z` },
    { event: 'project_interaction', sessionId: 'a', params: { interaction_type: 'open_details', project_id: 'gvp' }, ipHash: 'ip1', createdAt: `${day}T01:02:00.000Z` },
    { event: 'theme_change', sessionId: 'b', params: { theme: 'garden' }, ipHash: 'ip2', createdAt: `${day}T02:01:00.000Z` }
  ]
  const chatSessions = [
    {
      id: 'c1',
      createdAt: `${day}T03:00:00.000Z`,
      turns: [
        { modality: 'text', status: 'ok', firstTokenLatencyMs: 800, stream: true, fallbackUsed: false },
        { modality: 'text', status: 'error', errorCode: 'rate_limited', stream: true, fallbackUsed: true },
        { modality: 'voice', status: 'ok', turnDurationMs: 5000 }
      ],
      flagged: true
    }
  ]
  const contactMessages = [
    { id: 'm1', createdAt: `${day}T04:00:00.000Z`, name: 'Ada', email: 'ada@x.com', subject: 'Hi', status: 'sent' },
    { id: 'm2', createdAt: `${day}T05:00:00.000Z`, name: 'Bob', email: 'bob@x.com', subject: 'Hey', status: 'failed' }
  ]
  return { day, events, chatSessions, contactMessages }
}

test('buildDailyReport aggregates site interactions for the day', () => {
  const { day, events, chatSessions, contactMessages } = fixture()
  const report = buildDailyReport({ day, events, chatSessions, contactMessages })

  assert.equal(report.date, day)
  assert.ok(report.generatedAt, 'report records when it was generated')

  assert.equal(report.site.totalEvents, 5, 'counts every interaction')
  assert.equal(report.site.sessions, 2, 'distinct sessionId count')
  assert.equal(report.site.uniqueVisitors, 2, 'distinct ipHash count')

  // byEvent is a sorted, name+count breakdown.
  const pv = report.site.byEvent.find((e) => e.event === 'page_view')
  assert.equal(pv.count, 2)
  const names = report.site.byEvent.map((e) => e.event)
  assert.ok(names.includes('project_interaction'))
  // Sorted descending by count.
  for (let i = 1; i < report.site.byEvent.length; i++) {
    assert.ok(report.site.byEvent[i - 1].count >= report.site.byEvent[i].count, 'byEvent sorted desc')
  }
})

test('buildDailyReport rolls up chat agent activity', () => {
  const { day, events, chatSessions, contactMessages } = fixture()
  const report = buildDailyReport({ day, events, chatSessions, contactMessages })

  assert.equal(report.chat.sessions, 1)
  assert.equal(report.chat.turns, 3)
  assert.equal(report.chat.textTurns, 2)
  assert.equal(report.chat.voiceTurns, 1)
  assert.equal(report.chat.failures, 1, 'one error turn')
  assert.equal(report.chat.fallbacks, 1, 'one fallback turn')
  assert.equal(report.chat.flaggedSessions, 1)
  assert.equal(report.chat.errorsByCode.rate_limited, 1)
  assert.equal(report.chat.avgFirstTokenMs, 800, 'averages first-token latency over streamed ok turns')
})

test('buildDailyReport rolls up contact submissions', () => {
  const { day, events, chatSessions, contactMessages } = fixture()
  const report = buildDailyReport({ day, events, chatSessions, contactMessages })

  assert.equal(report.contact.submissions, 2)
  assert.equal(report.contact.sent, 1)
  assert.equal(report.contact.failed, 1)
})

test('buildDailyReport tolerates an all-empty day without throwing', () => {
  const report = buildDailyReport({ day: '2026-01-01', events: [], chatSessions: [], contactMessages: [] })
  assert.equal(report.site.totalEvents, 0)
  assert.equal(report.site.sessions, 0)
  assert.equal(report.chat.turns, 0)
  assert.equal(report.contact.submissions, 0)
  assert.equal(report.avgFirstTokenMs, undefined)
  assert.ok(Array.isArray(report.site.byEvent))
})

test('buildDailyReport buckets chat turns by per-turn capturedAt, not session start day', () => {
  // One session that starts at 23:50 on 06-15 and continues past midnight into 06-16.
  // The transcript row's createdAt is frozen at the first turn, but each turn carries
  // its own capturedAt — so each turn belongs to the UTC day of its own timestamp.
  const session = {
    id: 'cspan',
    createdAt: '2026-06-15T23:50:00.000Z',
    turns: [
      { modality: 'text', status: 'ok', capturedAt: '2026-06-15T23:50:00.000Z' },
      { modality: 'text', status: 'ok', capturedAt: '2026-06-16T00:10:00.000Z' }
    ]
  }

  const reportNext = buildDailyReport({ day: '2026-06-16', events: [], chatSessions: [session], contactMessages: [] })
  assert.equal(reportNext.chat.turns, 1, 'only the 00:10 turn belongs to 2026-06-16')
  assert.equal(reportNext.chat.sessions, 1, 'session counted on 2026-06-16 because it has a turn that day')

  const reportStart = buildDailyReport({ day: '2026-06-15', events: [], chatSessions: [session], contactMessages: [] })
  assert.equal(reportStart.chat.turns, 1, 'only the 23:50 turn belongs to 2026-06-15')
  assert.equal(reportStart.chat.sessions, 1, 'session counted on 2026-06-15 because it has a turn that day')
})

test('renderReportHtml produces a self-contained HTML document with the headline numbers', () => {
  const { day, events, chatSessions, contactMessages } = fixture()
  const report = buildDailyReport({ day, events, chatSessions, contactMessages })
  const html = renderReportHtml(report)

  assert.match(html, /<!doctype html>/i)
  assert.match(html, new RegExp(day))
  // headline metrics present
  assert.match(html, /Site interactions|Interactions/i)
  assert.match(html, /Chat/i)
  assert.match(html, /Contact/i)
  // the actual numbers show up
  assert.match(html, /\b5\b/) // total events
  assert.match(html, /page_view/)
})

test('renderReportHtml escapes user-controlled strings to prevent HTML injection', () => {
  const day = '2026-06-15'
  const events = [
    { event: '<img src=x onerror=alert(1)>', sessionId: 'a', ipHash: 'ip1', createdAt: `${day}T01:00:00.000Z` }
  ]
  const report = buildDailyReport({ day, events, chatSessions: [], contactMessages: [] })
  const html = renderReportHtml(report)
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, 'raw event name must be escaped, not injected')
  assert.match(html, /&lt;img/, 'the dangerous string is HTML-escaped')
})

test('buildDailyReport buckets a chat turn by its TRUE UTC day, not the literal offset-string prefix', () => {
  // 2026-06-16T01:00+05:00 is 2026-06-15T20:00Z — the UTC day is the 15th even
  // though the literal string starts "2026-06-16". (Chat text turns are written in
  // +00:00 offset form, so the day-bucketer must parse to UTC, not slice the prefix.)
  const session = {
    id: 'cz',
    createdAt: '2026-06-15T00:00:00.000Z',
    turns: [{ modality: 'text', status: 'ok', capturedAt: '2026-06-16T01:00:00.000+05:00' }]
  }
  assert.equal(
    buildDailyReport({ day: '2026-06-15', events: [], chatSessions: [session], contactMessages: [] }).chat.turns,
    1,
    'the turn belongs to UTC day 2026-06-15 (20:00Z)'
  )
  assert.equal(
    buildDailyReport({ day: '2026-06-16', events: [], chatSessions: [session], contactMessages: [] }).chat.turns,
    0,
    'and not to 2026-06-16 despite the +05:00 local-date reading'
  )
})

test('renderReportHtml escapes contact sender fields and chat error codes (untrusted -> operator inbox)', () => {
  const day = '2026-06-15'
  const report = buildDailyReport({
    day,
    events: [],
    chatSessions: [
      {
        id: 'cx',
        createdAt: `${day}T10:00:00.000Z`,
        turns: [{ modality: 'text', status: 'error', errorCode: '<svg/onload=alert(3)>', capturedAt: `${day}T10:00:00.000Z` }]
      }
    ],
    contactMessages: [
      {
        id: 'mx',
        createdAt: `${day}T11:00:00.000Z`,
        name: '<img src=x onerror=alert(1)>',
        email: '"><script>alert(2)</script>',
        subject: '<b>pwn</b>',
        status: 'failed'
      }
    ]
  })
  const html = renderReportHtml(report)
  // None of the attacker-controlled strings may appear raw in the document.
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, 'contact name must be escaped')
  assert.doesNotMatch(html, /<script>alert\(2\)<\/script>/, 'contact email must be escaped')
  assert.doesNotMatch(html, /<svg\/onload=alert\(3\)>/, 'chat error code must be escaped')
  // ...and their HTML-entity forms must be present (proof they were rendered, escaped).
  assert.match(html, /&lt;img src=x/, 'name rendered as entities')
  assert.match(html, /&lt;script&gt;alert\(2\)/, 'email rendered as entities')
  assert.match(html, /&lt;svg\/onload=alert\(3\)&gt;/, 'error code rendered as entities')
})

function smokeFixture() {
  return {
    overall: 'fail',
    depth: 'deep',
    generatedAt: '2026-06-15T12:00:00.000Z',
    checks: [
      { name: 'events_table', status: 'pass', latencyMs: 9, detail: 'reachable', cost: 'free' },
      { name: 'chat_model_live', status: 'fail', latencyMs: 25000, detail: '<img src=x onerror=alert(1)>', cost: 'paid' }
    ]
  }
}

test('buildDailyReport carries an optional smoke result through to the report', () => {
  const report = buildDailyReport({ day: '2026-06-15', events: [], chatSessions: [], contactMessages: [], smoke: smokeFixture() })
  assert.equal(report.smoke.overall, 'fail')
  assert.equal(report.smoke.checks.length, 2)
})

test('renderReportHtml renders a System health card (overall + checks, cost), escaping detail', () => {
  const report = buildDailyReport({ day: '2026-06-15', events: [], chatSessions: [], contactMessages: [], smoke: smokeFixture() })
  const html = renderReportHtml(report)
  assert.match(html, /System health/i, 'health card present')
  assert.match(html, /chat_model_live/, 'lists the live model check')
  assert.match(html, /paid/, 'shows the cost of the paid live probe')
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, 'check detail must be escaped')
  assert.match(html, /&lt;img/, 'dangerous detail rendered as entities')
})

test('renderReportHtml omits the System health card cleanly when no smoke is provided', () => {
  const report = buildDailyReport({ day: '2026-06-15', events: [], chatSessions: [], contactMessages: [] })
  assert.equal(report.smoke, undefined)
  const html = renderReportHtml(report)
  assert.doesNotMatch(html, /System health/i, 'no health card without smoke')
})

test('renderReportText yields a plain-text fallback with the date and section labels', () => {
  const { day, events, chatSessions, contactMessages } = fixture()
  const report = buildDailyReport({ day, events, chatSessions, contactMessages })
  const text = renderReportText(report)
  assert.match(text, new RegExp(day))
  assert.match(text, /Site/i)
  assert.match(text, /Chat/i)
  assert.match(text, /Contact/i)
})
