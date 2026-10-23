// M4 slice 17 (ADR-0017 §8) — the assistant-usage rollup behind GET
// /api/contact/admin/assistant-usage?days=. SDK-free with an injected day query, so it tests
// without node_modules (test/contact-core-no-aws-sdk.test.mjs's floor).
//   - days is a VALUE: clamped to [1, 90], default 30, one bounded query per day
//   - every facet is a CLOSED key space (+ 'other'): events arrive on a public route, so an
//     open-keyed facet would let anyone own rows of the owner's dashboard (invariant #17)
//   - counters are Object.create(null) (ADR-0020 §5 A7b)
import test from 'node:test'
import assert from 'node:assert/strict'
import { assistantUsage, parseDays } from '../aws/src/admin/assistant-usage-core.js'

const ev = (event, params = {}, sessionId = 's1', section = 'portfolio') => ({ event, params, sessionId, section, createdAt: '2026-10-22T10:00:00Z' })

function runner (rowsByDay) {
  const calls = []
  return { calls, queryDay: async ({ day, maxItems }) => { calls.push({ day, maxItems }); return rowsByDay[day] || [] } }
}

test('parseDays clamps a value to [1, 90] with a default of 30', () => {
  assert.equal(parseDays(undefined), 30)
  assert.equal(parseDays('7'), 7)
  assert.equal(parseDays('0'), 1)
  assert.equal(parseDays('365'), 90)
  assert.equal(parseDays('abc'), 30)
  assert.equal(parseDays('-5'), 1)
})

test('one bounded query per day, newest first, ending today', async () => {
  const r = runner({})
  await assistantUsage({ queryDay: r.queryDay, days: 3, today: '2026-10-23' })
  assert.deepEqual(r.calls.map((c) => c.day), ['2026-10-23', '2026-10-22', '2026-10-21'])
  assert.ok(r.calls.every((c) => c.maxItems <= 10000), 'a route-specific cap, not the report\'s 50,000')
})

test('totals and the four-step journey with conversion', async () => {
  const r = runner({
    '2026-10-22': [
      ev('chat_open', { surface: 'hero' }, 'a'), ev('chat_composer_submit', {}, 'a'),
      ev('chat_open', { surface: 'event' }, 'b'), ev('chat_voice_start', {}, 'b'), ev('chat_live_start', {}, 'b'),
      ev('chat_open', { surface: 'hero' }, 'c'), ev('chat_live_start', {}, 'c'), ev('chat_live_error', { phase: 'start' }, 'c'),
      ev('chat_open', {}, 'd')
    ]
  })
  const u = await assistantUsage({ queryDay: r.queryDay, days: 2, today: '2026-10-23' })
  assert.equal(u.days, 2)
  assert.equal(u.totals.opens, 4)
  assert.deepEqual(u.journey.map((s) => [s.step, s.sessions]), [['opened', 4], ['engaged', 3], ['voice', 2], ['voice-ok', 1]])
  assert.deepEqual(u.journey.map((s) => s.conversion), [1, 0.75, 0.6667, 0.5])
})

test('facets are closed key spaces: unknown values fold into other, prototype names count as numbers', async () => {
  const r = runner({
    '2026-10-23': [
      ev('chat_open', { surface: 'hero' }), ev('chat_open', { surface: 'toString' }), ev('chat_open', { surface: '__proto__' }),
      ev('chat_live_stop', { reason: 'no_mic_idle' }), ev('chat_live_stop', { reason: 'attacker-minted-1' }),
      ev('project_assistant_chip', { chip: 'summarize' }), ev('project_assistant_chip', { chip: 'constructor' }),
      ev('chat_open', {}, 'x', 'labs'), ev('chat_open', {}, 'y', 'made-up-section')
    ]
  })
  const u = await assistantUsage({ queryDay: r.queryDay, days: 1, today: '2026-10-23' })
  assert.equal(u.facets.openSurfaces.hero, 1)
  assert.equal(u.facets.openSurfaces.other, 2 + 2)
  assert.equal(Object.getPrototypeOf(u.facets.openSurfaces), null)
  assert.equal(u.facets.stopReasons.no_mic_idle, 1)
  assert.equal(u.facets.stopReasons.other, 1)
  assert.equal(u.facets.projectChips.summarize, 1)
  assert.equal(u.facets.projectChips.other, 1)
  assert.equal(u.facets.sections.labs, 1)
  assert.equal(u.facets.sections.other, 1)
  for (const facet of Object.values(u.facets)) {
    for (const v of Object.values(facet)) assert.equal(typeof v, 'number')
    assert.ok(Object.keys(facet).length <= 12, 'bounded key space')
  }
})

test('an empty window is all zeros with defined conversions, never NaN', async () => {
  const u = await assistantUsage({ queryDay: runner({}).queryDay, days: 1, today: '2026-10-23' })
  assert.equal(u.totals.opens, 0)
  assert.ok(u.journey.every((s) => Number.isFinite(s.conversion)))
})

// Wiring (contact-admin.js imports the SDK, so it is pinned by source, like admin-readonly-key).
import { readFileSync } from 'node:fs'
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('contact-admin.js serves GET .../assistant-usage through the core, on the events table', () => {
  const src = read('aws/src/contact-admin.js')
  assert.match(src, /from '\.\/admin\/assistant-usage-core\.js'/)
  const route = src.slice(src.indexOf("path.endsWith('/assistant-usage')") - 40, src.indexOf("path.endsWith('/assistant-usage')") + 700)
  assert.match(route, /method === 'GET'/)
  assert.match(route, /parseDays\(/)
  assert.match(route, /SITE_EVENTS_TABLE/)
  assert.match(route, /listPk: 'EVENT'/)
})

test('the template routes it with a brute-force throttle, and closes the two admin routes §12.4 found unthrottled', () => {
  const tpl = read('aws/template.yaml')
  assert.match(tpl, /Path: \/api\/contact\/admin\/assistant-usage\s*\n\s*Method: GET/)
  for (const route of ['GET /api/contact/admin/assistant-usage', 'GET /api/contact/admin/smoke', 'GET /api/contact/admin/session/{id}']) {
    const at = tpl.indexOf(`'${route}':`)
    assert.ok(at > -1, `no RouteSettings entry for ${route}`)
    assert.match(tpl.slice(at, at + 160), /ThrottlingBurstLimit: 5\s*\n\s*ThrottlingRateLimit: 2/, route)
  }
})

test('the new facets are prototype-free in source too (histogram-keys discipline, ADR-0017 §8.4)', () => {
  const core = read('aws/src/admin/assistant-usage-core.js')
  assert.doesNotMatch(core, /(facet|Facet|facets)\s*[=:]\s*\{\s*\}/)
  assert.match(core, /const facet = Object\.create\(null\)/)
})

// Critic (M4 review): the journey must be built from the events production ACTUALLY emits.
// chat_open fires only for programmatic opens (surface 'event'); the hero and header submit
// as hero_chat_submit / header_chat_submit; the footer is chat_open { surface: 'footer' }.
test('real entry events count as opens with their own surface, and as engagement where they send', async () => {
  const r = runner({
    '2026-10-23': [
      ev('hero_chat_submit', {}, 'h'),
      ev('header_chat_submit', {}, 'k'),
      ev('chat_open', { surface: 'footer' }, 'f'), // the footer's open, as js/app.js now emits it
      ev('chat_open', { surface: 'event' }, 'e'),
      ev('project_assistant_chip', { chip: 'summarize' }, 'p'),
      ev('selection_assistant_chip', { chars: '1-49', section: 'labs' }, 's'),
      ev('chat_live_start', {}, 'h'),
      ev('chat_composer_submit', { surface: 'dialog' }, ''), // no session: never a journey member
      ev('chat_launcher_resume', {}, 'h')
    ]
  })
  const u = await assistantUsage({ queryDay: r.queryDay, days: 1, today: '2026-10-23' })
  assert.equal(u.totals.opens, 6)
  assert.equal(u.facets.openSurfaces.hero, 1)
  assert.equal(u.facets.openSurfaces.header, 1)
  assert.equal(u.facets.openSurfaces.footer, 1)
  assert.equal(u.facets.openSurfaces.event, 1)
  assert.equal(u.facets.openSurfaces.chip, 1)
  assert.equal(u.facets.openSurfaces.selection, 1)
  assert.equal(u.totals.submits, 3, 'hero + header + composer submits')
  const steps = Object.fromEntries(u.journey.map((s) => [s.step, s.sessions]))
  assert.equal(steps.opened, 6)
  assert.equal(steps.engaged, 4, 'hero, header, project chip, selection chip sessions')
  assert.equal(steps.voice, 1)
})

test('the launcher chip is tracked once, not by both data-track and trackEvent', () => {
  const html = read('index.html')
  const chip = html.slice(html.indexOf('id="agentActiveChip"'), html.indexOf('id="agentActiveChip"') + 300)
  assert.doesNotMatch(chip.split('>')[0], /data-track=/)
})

// Re-review: data-track clicks (bindOutboundTracking) record the SAME name as the explicit
// trackEvent beside them, tagged { event_category: 'Outbound' }. The rollup counts the explicit
// one; the footer passes its surface through gvp:open-chat, so one click = one chat_open.
test('data-track duplicates of programmatic events are not counted twice', async () => {
  const outbound = { event_category: 'Outbound', event_label: '' }
  const r = runner({
    '2026-10-23': [
      ev('hero_chat_submit', { surface: 'hero' }, 'h'), ev('hero_chat_submit', outbound, 'h'),
      ev('chat_composer_submit', { surface: 'dialog' }, 'c'), ev('chat_composer_submit', outbound, 'c'),
      ev('footer_open_chat', outbound, 'f'), ev('chat_open', { surface: 'footer' }, 'f')
    ]
  })
  const u = await assistantUsage({ queryDay: r.queryDay, days: 1, today: '2026-10-23' })
  assert.equal(u.totals.opens, 2, 'hero submit + footer open, once each')
  assert.equal(u.totals.submits, 2)
  assert.equal(u.facets.openSurfaces.footer, 1)
  assert.equal(u.facets.openSurfaces.event, 0)
})

test('the footer button passes its surface through gvp:open-chat', () => {
  const app = read('js/app.js')
  assert.match(app, /footerOpenChatBtn[\s\S]{0,200}new CustomEvent\(EV_OPEN_CHAT, \{ detail: \{ surface: 'footer' \} \}\)/)
  const chat = read('js/chat.js')
  assert.match(chat, /const onOpenChatEvent = \(event\) =>[\s\S]{0,600}surface: \(event && event\.detail && event\.detail\.surface\) \|\| 'event'/)
})
