import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// S28 (TC-03) — getSessionEvents contract guard.
//
// getSessionEvents lives in aws/src/contact-admin.js, which top-level-imports
// @aws-sdk/client-cloudwatch (used elsewhere in that handler). The project keeps
// the `node --test` gate SDK-free (ADR-0005/0006: tests import SDK-free *-core
// modules, never the Lambda entry files) so it runs on a clean checkout with no
// aws/src/node_modules. A live `import` of getSessionEvents would load the SDK and
// break that gate (it did — caught in CI). Until getSessionEvents is extracted into
// an SDK-free core (TC-03 follow-up, a gated contact-admin.js change), we pin its
// security-relevant contract via a source-text guard — the same pattern
// daily-report-wiring.test.mjs uses for the SDK-laden daily-report handler.
const src = readFileSync(
  fileURLToPath(new URL('../aws/src/contact-admin.js', import.meta.url)),
  'utf8'
)

test('getSessionEvents validates ?date, defaults to today UTC, and threads lookbackDays:1 (TC-03 source guard)', () => {
  // Isolate the function body so each assertion is bound to getSessionEvents,
  // not some unrelated part of the handler.
  const m = src.match(/export async function getSessionEvents\([\s\S]*?\n}/)
  assert.ok(m, 'getSessionEvents is defined in contact-admin.js')
  const body = m[0]

  // Input validation: a strict YYYY-MM-DD regex guards the ?date param; anything
  // else falls back to today. This is the garbage/injection input guard.
  assert.ok(
    body.includes('/^\\d{4}-\\d{2}-\\d{2}$/'),
    'getSessionEvents guards ?date with a strict YYYY-MM-DD regex'
  )
  // Today-UTC default when date is absent/invalid.
  assert.ok(
    body.includes('new Date().toISOString().slice(0, 10)'),
    'falls back to today (UTC) when date is absent/invalid'
  )
  // lookbackDays:1 so a session crossing midnight surfaces on the right day.
  assert.ok(
    body.includes('lookbackDays: 1'),
    'threads lookbackDays:1 to the day-range query'
  )
  // Queries the EVENT partition (not contact rows).
  assert.ok(
    body.includes("listPk: 'EVENT'"),
    'queries the EVENT partition'
  )
})
