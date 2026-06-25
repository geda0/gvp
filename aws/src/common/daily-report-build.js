import { previousLocalDay, utcWindowDayForLocal } from './events-shared.js'
import { buildDailyReport } from './daily-report.js'

// ADR-0013: the daily report buckets by the owner's local day (REPORT_TZ), not UTC.
// This shared orchestration is invoked by BOTH the scheduled email Lambda and the
// admin /daily-report endpoint so they can never disagree on day attribution.
//
// SDK-free: `queryDay(opts) -> Promise<rows>` is injected (the callers pass a thin
// `(opts) => queryDay(ddb, opts)` wrapper), so this is unit-testable with a fake in
// the node:test baseline. `REPORT_TZ` defaults to America/Los_Angeles in code — no
// SAM-template env addition is required to ship.
const DEFAULT_TZ = 'America/Los_Angeles'

export async function buildDailyReportForDay(queryDay, { tables = {}, tz, day, smoke } = {}) {
  const reportTz = tz || process.env.REPORT_TZ || DEFAULT_TZ
  const localDay = day || previousLocalDay(reportTz)
  // Query a UTC window that is a SUPERSET of the local day (day+1, lookback 1); the
  // per-row local filter in buildDailyReport trims the ~24h overshoot on each side.
  const windowDay = utcWindowDayForLocal(localDay)
  const q = (tableName, listPk) =>
    tableName ? queryDay({ tableName, listPk, day: windowDay, lookbackDays: 1 }) : Promise.resolve([])
  const [events, chatSessions, contactMessages] = await Promise.all([
    q(tables.events, 'EVENT'),
    q(tables.chat, tables.chatListPk || 'CHAT_TRANSCRIPT'),
    q(tables.contact, tables.contactListPk || 'CONTACT')
  ])
  return buildDailyReport({ day: localDay, tz: reportTz, events, chatSessions, contactMessages, smoke })
}
