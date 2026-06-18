import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  timeControlMode,
  timeTriggerLabel,
  TIME_TRIGGER_ICON_HTML,
} from '../js/time-switcher-mode.js'

test('timeControlMode collapses to a dropdown at/below the mobile breakpoint and stays inline above it', () => {
  // Mobile widths collapse the time control into a dropdown.
  assert.equal(timeControlMode(320), 'dropdown')
  assert.equal(timeControlMode(500), 'dropdown')
  // The 767px breakpoint itself is mobile (boundary is inclusive).
  assert.equal(timeControlMode(767), 'dropdown')
  // Just past the breakpoint the inline control returns.
  assert.equal(timeControlMode(767.5), 'inline')
  assert.equal(timeControlMode(768), 'inline')
  assert.equal(timeControlMode(1200), 'inline')
  // Fail-safe: an unknown width must never hide the control — default to inline.
  assert.equal(timeControlMode(undefined), 'inline')
  assert.equal(timeControlMode(NaN), 'inline')
  assert.equal(timeControlMode(Infinity), 'inline')
})

test('timeTriggerLabel names the time-of-day control, differs by open state, and leaks no current hour', () => {
  const closed = timeTriggerLabel({ open: false })
  const open = timeTriggerLabel({ open: true })

  // A non-empty accessible name that names the control.
  assert.ok(closed.length > 0)
  assert.match(closed, /time of day/i)
  assert.match(open, /time of day/i)

  // Open vs closed must read differently (so AT announces the toggle).
  assert.notEqual(closed, open)

  // The label is static chrome, never the live hour — it must leak no digits.
  assert.doesNotMatch(closed, /\d/)
  assert.doesNotMatch(open, /\d/)
})

test('TIME_TRIGGER_ICON_HTML is the legacy theme-switcher Auto SVG (half light / half dark)', () => {
  assert.match(TIME_TRIGGER_ICON_HTML, /theme-icon--auto/)
  assert.match(TIME_TRIGGER_ICON_HTML, /<circle/)
  assert.match(TIME_TRIGGER_ICON_HTML, /<path/)
})
