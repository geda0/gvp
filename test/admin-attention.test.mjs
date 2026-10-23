// M8 item 7 (ADR-0021) — the admin "Attention" strip: a pure view-model over data the
// dashboard already loads, ranked bad → warn → info, each row naming the tab that owns it,
// and an explicit "all clear" when nothing needs attention. Only sources that exist today are
// read; mic denials and tool errors arrive with M4's facets and are not invented here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attentionItems, renderAttention } from '../js/admin-attention.js'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const quiet = {
  contactSummary: { failed: 0, deadLettered: 0 },
  health: { apiConfigured: true, dlqVisible: 0, alarmState: 'OK' },
  smoke: { overall: 'pass' },
  chatSummary: { unreviewed: 0, flagged: 0, stream: { streamFailures: 0, recentFailures: [] } }
}

test('nothing wrong → no items (the renderer says all clear)', () => {
  assert.deepEqual(attentionItems(quiet, NOW), [])
})

test('contact failures, dead letters, a firing alarm and a failed smoke are bad, on the contact tab', () => {
  const items = attentionItems({
    ...quiet,
    contactSummary: { failed: 2, deadLettered: 1, mostRecentFailure: { lastError: 'Resend 422' } },
    health: { apiConfigured: true, dlqVisible: 1, alarmState: 'ALARM' },
    smoke: { overall: 'fail' }
  }, NOW)
  assert.ok(items.length >= 4)
  assert.ok(items.every((i) => i.level === 'bad' && i.tab === 'contact'))
  assert.ok(items.some((i) => /2 contact messages failed/.test(i.text) && /Resend 422/.test(i.text)))
  assert.ok(items.some((i) => /dead-letter/i.test(i.text)))
  assert.ok(items.some((i) => /alarm/i.test(i.text)))
  assert.ok(items.some((i) => /smoke/i.test(i.text)))
})

test('a chat failure in the last 24 h is bad, an older one warn; both name the latest error code', () => {
  const recent = attentionItems({ ...quiet, chatSummary: { ...quiet.chatSummary, stream: { streamFailures: 3, recentFailures: [{ errorCode: 'upstream_503', capturedAt: '2026-10-23T09:00:00Z' }] } } }, NOW)
  assert.equal(recent[0].level, 'bad'); assert.equal(recent[0].tab, 'transcripts'); assert.match(recent[0].text, /3 chat turns failed[\s\S]*upstream_503/)
  const old = attentionItems({ ...quiet, chatSummary: { ...quiet.chatSummary, stream: { streamFailures: 1, recentFailures: [{ errorCode: 'timeout', capturedAt: '2026-10-20T09:00:00Z' }] } } }, NOW)
  assert.equal(old[0].level, 'warn')
})

test('the review queue is info; ranking is bad → warn → info regardless of input order', () => {
  const items = attentionItems({
    ...quiet,
    smoke: { overall: 'warn' },
    contactSummary: { failed: 1, deadLettered: 0 },
    chatSummary: { unreviewed: 4, flagged: 2, stream: { streamFailures: 0, recentFailures: [] } }
  }, NOW)
  assert.deepEqual(items.map((i) => i.level), ['bad', 'warn', 'info'])
  assert.match(items[2].text, /4 conversations await review \(2 flagged\)/)
})

test('a source that failed to load is a warn, never silently "all clear"', () => {
  const items = attentionItems({ ...quiet, chatSummary: null }, NOW)
  assert.deepEqual(items.map((i) => [i.level, i.tab]), [['warn', 'transcripts']])
  assert.match(items[0].text, /could not load/i)
})

test('renderAttention writes text only, an Open button per row, and "All clear" when empty', () => {
  const made = []
  const el = (tag) => { const n = { tag, children: [], textContent: '', dataset: {}, handlers: {}, appendChild (c) { this.children.push(c) }, addEventListener (t, f) { this.handlers[t] = f }, replaceChildren (...c) { this.children = c } }; made.push(n); return n }
  globalThis.document = { createElement: el }
  try {
    const root = el('div'); const opened = []
    renderAttention(root, [{ level: 'bad', text: '<b>x</b>', tab: 'contact' }], (tab) => opened.push(tab))
    const row = root.children[0]
    assert.equal(row.dataset.level, 'bad')
    assert.equal(row.children[0].textContent, '<b>x</b>', 'text, never HTML')
    row.children[1].handlers.click()
    assert.deepEqual(opened, ['contact'])
    renderAttention(root, [], () => {})
    assert.match(root.children[0].textContent, /all clear/i)
  } finally { delete globalThis.document }
})

test('admin.js renders the strip from the loaded data, above the tabs in admin/index.html', () => {
  const html = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8')
  assert.ok(html.indexOf('id="adminAttention"') > -1 && html.indexOf('id="adminAttention"') < html.indexOf('id="adminTabContact"'))
  const js = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8')
  assert.match(js, /from '\.\/admin-attention\.js'/)
  assert.match(js, /renderAttention\(attentionEl, attentionItems\(/)
})

// Critic round 1 (M8 item 7).
test('ranking really sorts: a warn pushed first still lands after the bads', () => {
  // Contact data failed (warn, pushed first), smoke failing (bad), fresh chat failure (bad).
  const items = attentionItems({
    contactSummary: null, health: null, smoke: { overall: 'fail' },
    chatSummary: { unreviewed: 1, flagged: 0, stream: { streamFailures: 1, recentFailures: [{ errorCode: 'x', capturedAt: '2026-10-23T11:00:00Z' }] } }
  }, NOW)
  assert.deepEqual(items.map((i) => i.level), ['bad', 'bad', 'warn', 'info'])
})

test('an env with no chat table is not a failure: no item, so "all clear" stays reachable', () => {
  assert.deepEqual(attentionItems({ ...quiet, chatSummary: { notConfigured: true } }, NOW), [])
})

test('smoke checks that could not run are a warn, not silence', () => {
  const items = attentionItems({ ...quiet, smoke: { overall: 'unavailable' } }, NOW)
  assert.deepEqual(items.map((i) => [i.level, i.tab]), [['warn', 'contact']])
  assert.match(items[0].text, /smoke checks could not run/i)
})

test('an unconfigured contact API is bad; missing contact data is a warn', () => {
  assert.ok(attentionItems({ ...quiet, health: { ...quiet.health, apiConfigured: false } }, NOW).some((i) => i.level === 'bad' && /not configured/.test(i.text)))
  assert.ok(attentionItems({ ...quiet, health: null }, NOW).some((i) => i.level === 'warn' && i.tab === 'contact'))
})

test('admin.js keeps the strip current: chat reloads, smoke failure, and a 503 "not configured"', () => {
  const js = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8')
  const chatLoad = js.slice(js.indexOf('async function loadChatDashboard'), js.indexOf('async function loadMoreChatTranscripts'))
  assert.match(chatLoad, /attentionData\.chatSummary = /, 'loadChatDashboard must refresh the strip\'s chat data')
  assert.match(chatLoad, /refreshAttention\(\)/)
  const smoke = js.slice(js.indexOf('async function loadSmoke'), js.indexOf('async function runDeepProbe'))
  assert.match(smoke.slice(smoke.indexOf('catch')), /attentionData\.smoke = \{ overall: 'unavailable' \}/)
  assert.match(js, /not configured/i)
})
