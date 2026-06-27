import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDailyReport, renderReportHtml, renderReportText } from '../aws/src/common/daily-report.js'
// ADR-0014 adds these exports. Imported as a namespace (not named bindings) so the
// test file still LINKS before they exist — each new test then fails on a real
// assertion (function not yet a function), not a module-link SyntaxError that would
// take the whole file down.
import * as dailyReport from '../aws/src/common/daily-report.js'

const stabilizeSmokeForReport = (...args) => dailyReport.stabilizeSmokeForReport(...args)
const isResendIdempotencyConflict = (...args) => dailyReport.isResendIdempotencyConflict(...args)

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
  // ADR-0014: generatedAt is pinned to the report day's canonical instant, not a
  // wall-clock now() — the email body under key daily-report-${day} must be
  // deterministic so Resend replays the original 2xx instead of 409-ing retries.
  assert.equal(report.generatedAt, `${day}T00:00:00.000Z`, 'generatedAt is pinned to the report day, not wall-clock')

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
  // Empty day has no streamed ok turns, so avg first-token latency is undefined.
  // (Guards report.chat.avgFirstTokenMs — the real key — not a vacuous top-level miss:
  // a stray NaN or number from an over-eager average would now fail this.)
  assert.equal(report.chat.avgFirstTokenMs, undefined)
  assert.ok(Array.isArray(report.site.byEvent))
})

test('buildDailyReport reports avgFirstTokenMs on a populated day (non-vacuous counterpart)', () => {
  const { day, events, chatSessions, contactMessages } = fixture()
  const report = buildDailyReport({ day, events, chatSessions, contactMessages })
  // One streamed ok turn with firstTokenLatencyMs 800 -> average is 800.
  assert.equal(report.chat.avgFirstTokenMs, 800)
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

// ---- ADR-0014: deterministic idempotency-keyed body ----

test('buildDailyReport pins generatedAt to the report day rather than wall-clock', () => {
  // The send is keyed daily-report-${day}; Resend 409s if the same key sees a
  // changed body. A wall-clock generatedAt changes every call, so it MUST be the
  // day's canonical instant.
  const report = buildDailyReport({ day: '2026-06-25', chatSessions: [], events: [], contactMessages: [] })
  assert.equal(report.generatedAt, '2026-06-25T00:00:00.000Z')
})

test('buildDailyReport renders byte-identical HTML and text across two builds with identical inputs', () => {
  // This is the exact property Resend's idempotency depends on: same day + same
  // rows -> same body, so a retry replays the original 2xx instead of 409.
  const { day, events, chatSessions, contactMessages } = fixture()
  const r1 = buildDailyReport({ day, events, chatSessions, contactMessages })
  const r2 = buildDailyReport({ day, events, chatSessions, contactMessages })

  assert.equal(r1.generatedAt, r2.generatedAt, 'generatedAt is stable across builds')
  assert.equal(renderReportHtml(r1), renderReportHtml(r2), 'HTML body is byte-identical across builds')
  assert.equal(renderReportText(r1), renderReportText(r2), 'text body is byte-identical across builds')
})

// ---- ADR-0014: stabilizeSmokeForReport projects a live rollup to categorical form ----

function liveSmokeFixture() {
  return {
    overall: 'pass',
    depth: 'deep',
    generatedAt: '2026-06-26T12:00:00Z',
    checks: [
      { name: 'contact_table', status: 'pass', latencyMs: 42, cost: 'free', detail: 'reachable in 42ms' },
      { name: 'chat_model_live', status: 'fail', latencyMs: 1900, cost: 'paid', detail: 'HTTP 500 after 1900ms' }
    ]
  }
}

test('stabilizeSmokeForReport keeps categorical fields and drops latency, timestamp, and detail', () => {
  const stabilized = stabilizeSmokeForReport(liveSmokeFixture())
  assert.deepEqual(stabilized, {
    overall: 'pass',
    depth: 'deep',
    checks: [
      { name: 'contact_table', status: 'pass', cost: 'free' },
      { name: 'chat_model_live', status: 'fail', cost: 'paid' }
    ]
  })
})

test('stabilizeSmokeForReport is deterministic and does not mutate its input', () => {
  const live = liveSmokeFixture()
  const before = JSON.parse(JSON.stringify(live))
  const a = stabilizeSmokeForReport(live)
  const b = stabilizeSmokeForReport(live)
  assert.deepEqual(a, b, 'two projections of the same input are deep-equal')
  assert.deepEqual(live, before, 'the original live smoke object is not mutated')
})

test('stabilizeSmokeForReport returns undefined for empty/missing smoke (card omitted)', () => {
  assert.equal(stabilizeSmokeForReport(undefined), undefined)
  assert.equal(stabilizeSmokeForReport(null), undefined)
  assert.equal(stabilizeSmokeForReport({}), undefined, 'a checks-less object projects to undefined so the card is omitted')
})

test('renderReportHtml of a stabilized smoke shows check names and status but no latency numbers', () => {
  const smoke = stabilizeSmokeForReport(liveSmokeFixture())
  const report = buildDailyReport({ day: '2026-06-26', events: [], chatSessions: [], contactMessages: [], smoke })
  const html = renderReportHtml(report)

  assert.match(html, /contact_table/, 'keeps the check name')
  assert.match(html, /chat_model_live/, 'keeps the live model check name')
  assert.match(html, /paid/, 'keeps the categorical cost')
  // The latency numbers must not survive into the deduped email body.
  assert.doesNotMatch(html, /42\s*ms/i, 'no per-check latency number for the contact probe')
  assert.doesNotMatch(html, /1900/, 'no per-check latency number for the live model probe')
})

test('buildDailyReport with a stabilized smoke renders byte-identical HTML and text across builds', () => {
  // The smoke card was the second (trickier) non-determinism source. Pin that its
  // stabilized form is ALSO byte-stable through both renderers, so the smoke branch
  // can't silently reintroduce the per-retry drift that 409s the send.
  const smoke = stabilizeSmokeForReport(liveSmokeFixture())
  const { day, events, chatSessions, contactMessages } = fixture()
  const r1 = buildDailyReport({ day, events, chatSessions, contactMessages, smoke })
  const r2 = buildDailyReport({ day, events, chatSessions, contactMessages, smoke })
  assert.equal(renderReportHtml(r1), renderReportHtml(r2), 'HTML (incl. smoke card) is byte-identical')
  assert.equal(renderReportText(r1), renderReportText(r2), 'text (incl. smoke) is byte-identical')
})

test('renderReportText of a stabilized smoke degrades cleanly — name + cost, no latency or detail', () => {
  const smoke = stabilizeSmokeForReport(liveSmokeFixture())
  const report = buildDailyReport({ day: '2026-06-26', events: [], chatSessions: [], contactMessages: [], smoke })
  const text = renderReportText(report)
  assert.match(text, /chat_model_live/, 'keeps the check name')
  assert.match(text, /paid/i, 'keeps the categorical cost')
  assert.doesNotMatch(text, /\d\s*ms/i, 'no per-check latency number survives into the text body')
  assert.doesNotMatch(text, /HTTP 500/, 'no live detail string survives')
})

// ---- ADR-0014: isResendIdempotencyConflict predicate ----

test('isResendIdempotencyConflict is true only for a 409 invalid_idempotent_request', () => {
  assert.equal(
    isResendIdempotencyConflict({ status: 409, body: { name: 'invalid_idempotent_request' } }),
    true,
    'the specific Resend idempotency conflict is recognized'
  )
})

test('isResendIdempotencyConflict is false for other 409 names, non-409, bare Error, null, and undefined', () => {
  assert.equal(isResendIdempotencyConflict({ status: 409, body: { name: 'something_else' } }), false, 'other-named 409 still throws')
  assert.equal(isResendIdempotencyConflict({ status: 500, body: { name: 'invalid_idempotent_request' } }), false, 'non-409 status is a real failure')
  assert.equal(isResendIdempotencyConflict(new Error('x')), false, 'a bare Error has no status/body')
  assert.equal(isResendIdempotencyConflict(null), false)
  assert.equal(isResendIdempotencyConflict(undefined), false)
})
