// M4 slice 18 (ADR-0017 §8) — the admin "Assistant" tab over GET .../assistant-usage.
// A pure view-model (KPIs -> journey with conversion -> facets) and a textContent-only renderer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assistantViewModel, renderAssistant } from '../js/admin-assistant.js'

const facet = (o) => Object.assign(Object.create(null), o)
const USAGE = {
  days: 30,
  totals: { opens: 40, submits: 25, voiceStarts: 10, voiceErrors: 2, voiceStops: 8, launcherResumes: 3, projectChips: 5, selectionOffers: 6, selectionChips: 2 },
  journey: [
    { step: 'opened', sessions: 40, conversion: 1 },
    { step: 'engaged', sessions: 30, conversion: 0.75 },
    { step: 'voice', sessions: 10, conversion: 0.3333 },
    { step: 'voice-ok', sessions: 8, conversion: 0.8 }
  ],
  facets: {
    openSurfaces: facet({ hero: 30, event: 10, dialog: 0, other: 0 }),
    sections: facet({ home: 5, portfolio: 30, labs: 5, other: 0 })
  }
}

test('KPIs: conversations, turns started, voice share and a toned voice failure rate', () => {
  const vm = assistantViewModel(USAGE)
  const byLabel = Object.fromEntries(vm.kpis.map((k) => [k.label, k]))
  assert.equal(byLabel['Chats opened'].value, '40')
  assert.equal(byLabel['Voice starts'].value, '10')
  assert.equal(byLabel['Voice failure rate'].value, '20%')
  assert.equal(byLabel['Voice failure rate'].tone, 'bad')
})

test('journey: human labels and conversion percentages', () => {
  const vm = assistantViewModel(USAGE)
  assert.deepEqual(vm.journey.map((s) => [s.label, s.sessions, s.pct]), [
    ['Opened the assistant', 40, '100%'], ['Asked something', 30, '75%'], ['Started voice', 10, '33%'], ['Voice worked', 8, '80%']
  ])
})

test('facets: sorted by count, zero rows dropped, with a share of the facet total', () => {
  const vm = assistantViewModel(USAGE)
  const surfaces = vm.facets.find((f) => f.key === 'openSurfaces')
  assert.deepEqual(surfaces.rows.map((r) => [r.key, r.count, r.share]), [['hero', 30, '75%'], ['event', 10, '25%']])
})

test('an empty or missing payload renders an explicit empty state, never NaN', () => {
  const vm = assistantViewModel(null)
  assert.equal(vm.empty, true)
  assert.ok(!JSON.stringify(assistantViewModel({ days: 7, totals: {}, journey: [], facets: {} })).includes('NaN'))
})

test('renderAssistant writes text only', () => {
  const made = []
  const el = (tag) => { const n = { tag, children: [], textContent: '', dataset: {}, appendChild (c) { this.children.push(c); return c }, replaceChildren (...c) { this.children = c } }; made.push(n); return n }
  globalThis.document = { createElement: el }
  try {
    const root = el('div')
    renderAssistant(root, assistantViewModel({ ...USAGE, facets: { openSurfaces: facet({ '<img src=x>': 1 }) } }))
    assert.ok(made.some((n) => n.textContent === '<img src=x>'), 'keys are rendered as text')
    assert.ok(made.every((n) => !('innerHTML' in n) || n.innerHTML === undefined))
  } finally { delete globalThis.document }
})

test('admin wiring: a fourth tab that loads the rollup once, with a days selector', () => {
  const html = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8')
  assert.match(html, /id="adminTabAssistant"[^>]*data-tab="assistant"/)
  assert.match(html, /id="adminPanelAssistant"[^>]*hidden/)
  assert.match(html, /id="assistantDays"/)
  const js = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8')
  assert.match(js, /from '\.\/admin-assistant\.js'/)
  assert.match(js, /requestContact\(`\/assistant-usage\?days=\$\{/)
  assert.match(js, /\['transcripts', 'report', 'assistant'\]\.includes\(tab\)/)
})
