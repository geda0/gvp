// ADR-0017 §12.1 (same defect class as ADR-0020 §5 A7b): /api/events is public, so event,
// section and page names are caller-supplied, and so are chat error codes and contact
// statuses once stored. Counting them into a plain {} lets `toString` become the string
// "function toString() { [native code] }1" and `__proto__` vanish — in an EMAILED report.
// Behavioural, not name-matched: it feeds the hostile keys through buildDailyReport.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDailyReport } from '../aws/src/common/daily-report.js'

const HOSTILE = ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']

test('site counters count prototype-named events, sections and pages as numbers', () => {
  const events = HOSTILE.flatMap((k) => [
    { event: k, section: k, page: k, sessionId: 's', ipHash: 'h' },
    { event: k, section: k, page: k, sessionId: 's', ipHash: 'h' }
  ])
  const { site } = buildDailyReport({ events })
  for (const k of HOSTILE) {
    assert.deepEqual(site.byEvent.find((r) => r.event === k), { event: k, count: 2 }, `byEvent ${k}`)
    assert.deepEqual(site.bySection.find((r) => r.section === k), { section: k, count: 2 }, `bySection ${k}`)
    assert.deepEqual(site.topPages.find((r) => r.page === k), { page: k, count: 2 }, `topPages ${k}`)
  }
})

test('chat errorsByCode and contact byStatus count prototype-named keys as numbers', () => {
  const chatSessions = [{ turns: HOSTILE.map((k) => ({ status: 'error', errorCode: k })) }]
  const contactMessages = HOSTILE.map((k) => ({ status: k }))
  const report = buildDailyReport({ chatSessions, contactMessages })
  for (const k of HOSTILE) {
    assert.equal(Object.getOwnPropertyDescriptor(report.chat.errorsByCode, k)?.value, 1, `errorsByCode ${k}`)
    assert.equal(Object.getOwnPropertyDescriptor(report.contact.byStatus, k)?.value, 1, `byStatus ${k}`)
  }
  assert.equal(JSON.parse(JSON.stringify(report.chat.errorsByCode)).toString, 1, 'survives the JSON the email is built from')
})
