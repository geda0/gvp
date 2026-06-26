import test from 'node:test'
import assert from 'node:assert/strict'
import { localDayOf, previousLocalDay, utcWindowDayForLocal } from '../aws/src/common/events-shared.js'
import { buildDailyReport } from '../aws/src/common/daily-report.js'
import { buildDailyReportForDay } from '../aws/src/common/daily-report-build.js'

// ADR-0013: the daily report's "day" is the owner's local calendar day (REPORT_TZ),
// not UTC, so the email/report and the local-time dashboard agree at the day boundary.
const PT = 'America/Los_Angeles'

test('localDayOf buckets an instant by the target timezone, not UTC', () => {
  // 02:00 UTC on the 25th is still 7 PM on the 24th in Pacific (PDT, UTC-7).
  assert.equal(localDayOf('2026-06-25T02:00:00Z', PT), '2026-06-24')
  assert.equal(localDayOf('2026-06-25T02:00:00Z', 'UTC'), '2026-06-25')
  // chat writers emit the offset form (+00:00); same instant, same bucket.
  assert.equal(localDayOf('2026-06-25T02:00:00+00:00', PT), '2026-06-24')
  // unambiguous midday.
  assert.equal(localDayOf('2026-06-24T20:00:00Z', PT), '2026-06-24') // 1 PM PDT
})

test('localDayOf with tz=UTC matches the old utcDayOf (backward compatible)', () => {
  assert.equal(localDayOf('2026-06-15T03:00:00.000Z', 'UTC'), '2026-06-15')
})

test('localDayOf falls back to the leading 10 chars on an unparseable value', () => {
  assert.equal(localDayOf('not-a-date', PT), 'not-a-date'.slice(0, 10))
  assert.doesNotThrow(() => localDayOf(undefined, PT))
})

test('previousLocalDay returns the local calendar day before now', () => {
  // 2026-06-25 10:00 UTC = 03:00 PDT on the 25th -> previous local day = the 24th.
  assert.equal(previousLocalDay(PT, new Date('2026-06-25T10:00:00Z')), '2026-06-24')
  // 2026-06-25 06:00 UTC = 23:00 PDT on the 24th -> "today" PT is the 24th -> previous = 23rd.
  assert.equal(previousLocalDay(PT, new Date('2026-06-25T06:00:00Z')), '2026-06-23')
})

test('utcWindowDayForLocal is the next calendar day (so day + lookback:1 covers the local day)', () => {
  assert.equal(utcWindowDayForLocal('2026-06-24'), '2026-06-25')
  assert.equal(utcWindowDayForLocal('2026-12-31'), '2027-01-01')
})

test('REGRESSION: a 7 PM-Pacific turn counts in the Pacific day, not the next UTC day', () => {
  // capturedAt 02:00 UTC on the 25th == 7 PM PDT on the 24th.
  const chatSessions = [{
    id: 'c1', createdAt: '2026-06-25T02:00:00Z', turns: [
      { modality: 'text', status: 'ok', capturedAt: '2026-06-25T02:00:00Z' },
      { modality: 'voice', status: 'ok', capturedAt: '2026-06-25T02:05:00Z' }
    ]
  }]
  const events = [{ event: 'page_view', sessionId: 'a', ipHash: 'ip1', createdAt: '2026-06-25T02:00:00Z' }]
  const contactMessages = [{ id: 'm1', createdAt: '2026-06-25T02:00:00Z', status: 'sent' }]

  // Pacific report for the 24th: the evening activity is counted.
  const pt = buildDailyReport({ day: '2026-06-24', tz: PT, events, chatSessions, contactMessages })
  assert.equal(pt.chat.turns, 2, 'both evening turns count for the Pacific 24th')
  assert.equal(pt.site.totalEvents, 1)
  assert.equal(pt.contact.submissions, 1)

  // The old UTC behavior would have shown 0 for the 24th — the bug being fixed.
  const utc = buildDailyReport({ day: '2026-06-24', tz: 'UTC', events, chatSessions, contactMessages })
  assert.equal(utc.chat.turns, 0, 'UTC bucketing misses the evening turns — the bug')
  assert.equal(utc.site.totalEvents, 0)
  assert.equal(utc.contact.submissions, 0)
})

test('site + contact aggregators filter by day too (the widened window over-fetches neighbours)', () => {
  const events = [
    { event: 'page_view', sessionId: 'a', ipHash: 'ip1', createdAt: '2026-06-25T02:00:00Z' }, // 24th PT
    { event: 'page_view', sessionId: 'b', ipHash: 'ip2', createdAt: '2026-06-25T20:00:00Z' } // 25th PT (1 PM PDT)
  ]
  const contactMessages = [
    { id: 'm1', createdAt: '2026-06-25T02:00:00Z', status: 'sent' }, // 24th PT
    { id: 'm2', createdAt: '2026-06-25T20:00:00Z', status: 'sent' } // 25th PT
  ]
  const r = buildDailyReport({ day: '2026-06-24', tz: PT, events, chatSessions: [], contactMessages })
  assert.equal(r.site.totalEvents, 1, 'only the 24th-PT event, not the 25th-PT neighbour')
  assert.equal(r.contact.submissions, 1, 'only the 24th-PT contact')
})

test('buildDailyReport with no tz defaults to UTC (backward compatible)', () => {
  const events = [{ event: 'page_view', sessionId: 'a', ipHash: 'ip1', createdAt: '2026-06-15T03:00:00Z' }]
  const r = buildDailyReport({ day: '2026-06-15', events, chatSessions: [], contactMessages: [] })
  assert.equal(r.site.totalEvents, 1)
})

test('buildDailyReportForDay queries the local-day UTC window + labels with the local day', async () => {
  const calls = []
  const fakeQueryDay = async (opts) => {
    calls.push(opts)
    if (opts.listPk === 'CHAT_TRANSCRIPT') {
      return [{ id: 's', createdAt: '2026-06-25T02:00:00Z', turns: [{ modality: 'text', status: 'ok', capturedAt: '2026-06-25T02:00:00Z' }] }]
    }
    return []
  }
  const report = await buildDailyReportForDay(fakeQueryDay, {
    tables: { events: 'EV', chat: 'CH', contact: 'CT' },
    tz: PT,
    day: '2026-06-24'
  })
  assert.equal(calls.length, 3, 'one query per source')
  for (const c of calls) {
    assert.equal(c.day, '2026-06-25', 'window day = local day + 1')
    assert.equal(c.lookbackDays, 1, 'lookback 1 so the window covers the local day')
  }
  assert.equal(report.date, '2026-06-24', 'report labelled with the LOCAL day')
  assert.equal(report.chat.turns, 1, 'the evening turn counts for the Pacific day')
})

test('buildDailyReportForDay defaults tz + day when omitted', async () => {
  const fakeQueryDay = async () => []
  const report = await buildDailyReportForDay(fakeQueryDay, { tables: { events: 'EV', chat: 'CH', contact: 'CT' } })
  assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/, 'defaults to the previous local day')
})

test('default day is the previous LOCAL day, not the previous UTC day', async () => {
  // Both the admin /daily-report endpoint (no ?date) and the scheduled email rely on
  // this default. It MUST be the owner-local previous day (REPORT_TZ default
  // America/Los_Angeles), matching the email — never previousUtcDay (the bug: near
  // midnight UTC the two differ by a calendar day, so the board/email read 0).
  const fakeQueryDay = async () => []
  const report = await buildDailyReportForDay(fakeQueryDay, { tables: { events: 'EV', chat: 'CH', contact: 'CT' } })
  assert.equal(report.date, previousLocalDay('America/Los_Angeles'), 'default = previous LOCAL day')
  assert.equal(report.tz, 'America/Los_Angeles', 'default tz is the owner timezone')
})
