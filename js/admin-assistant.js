// M4 slice 18 (ADR-0017 §8) — the admin "Assistant" tab: a pure view-model over
// GET /api/contact/admin/assistant-usage (KPIs -> journey with conversion -> facets), and a
// renderer that writes textContent only (facet keys come from public input).

const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`
const num = (n) => String(Number(n) || 0)

const JOURNEY_LABELS = {
  opened: 'Opened the assistant',
  engaged: 'Asked something',
  voice: 'Started voice',
  'voice-ok': 'Voice worked'
}

const FACET_TITLES = {
  openSurfaces: 'Opened from',
  sections: 'Section when opened',
  projectChips: 'Project chips',
  stopReasons: 'Why voice stopped',
  liveErrorPhases: 'Where voice failed'
}

export function assistantViewModel (usage) {
  if (!usage || typeof usage !== 'object') return { empty: true, days: 0, kpis: [], journey: [], facets: [] }
  const t = usage.totals || {}
  const starts = Number(t.voiceStarts) || 0
  const errors = Number(t.voiceErrors) || 0
  const failRate = starts > 0 ? errors / starts : 0
  const kpis = [
    { label: 'Chats opened', value: num(t.opens) },
    { label: 'Messages sent', value: num(t.submits) },
    { label: 'Voice starts', value: num(starts) },
    { label: 'Voice failure rate', value: pct(failRate), tone: failRate >= 0.1 ? 'bad' : failRate > 0 ? 'warn' : 'ok' },
    { label: 'Project chips used', value: num(t.projectChips) },
    { label: 'Selection offers taken', value: `${num(t.selectionChips)} of ${num(t.selectionOffers)}` }
  ]
  const journey = (usage.journey || []).map((s) => ({
    step: s.step,
    label: JOURNEY_LABELS[s.step] || String(s.step),
    sessions: Number(s.sessions) || 0,
    pct: pct(s.conversion)
  }))
  const facets = Object.entries(usage.facets || {}).map(([key, counts]) => {
    const entries = Object.entries(counts || {}).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => v > 0)
    const total = entries.reduce((sum, [, v]) => sum + v, 0)
    return {
      key,
      title: FACET_TITLES[key] || key,
      rows: entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, v]) => ({ key: k, count: v, share: pct(total ? v / total : 0) }))
    }
  })
  return { empty: false, days: Number(usage.days) || 0, kpis, journey, facets }
}

export function renderAssistant (root, vm) {
  const el = (tag, text, cls) => {
    const n = document.createElement(tag)
    if (text !== undefined) n.textContent = text
    if (cls) n.className = cls
    return n
  }
  if (!vm || vm.empty) {
    root.replaceChildren(el('p', 'No assistant usage data yet.', 'admin-status'))
    return
  }
  const kpiWrap = el('div', undefined, 'assistant-kpis')
  for (const k of vm.kpis) {
    const card = el('div', undefined, 'assistant-kpi')
    if (k.tone) card.dataset.tone = k.tone
    card.appendChild(el('span', k.label, 'assistant-kpi__label'))
    card.appendChild(el('strong', k.value, 'assistant-kpi__value'))
    kpiWrap.appendChild(card)
  }
  const journey = el('ol', undefined, 'assistant-journey')
  for (const s of vm.journey) journey.appendChild(el('li', `${s.label}: ${s.sessions} (${s.pct})`))
  const facetWrap = el('div', undefined, 'assistant-facets')
  for (const f of vm.facets) {
    const box = el('section', undefined, 'assistant-facet')
    box.appendChild(el('h3', f.title))
    if (!f.rows.length) box.appendChild(el('p', 'None yet.', 'admin-status'))
    const list = el('ul')
    for (const r of f.rows) {
      const li = el('li')
      li.appendChild(el('span', r.key, 'assistant-facet__key'))
      li.appendChild(el('span', `${r.count} (${r.share})`, 'assistant-facet__count'))
      list.appendChild(li)
    }
    box.appendChild(list)
    facetWrap.appendChild(box)
  }
  root.replaceChildren(
    el('h3', `Last ${vm.days} days`),
    kpiWrap,
    el('h3', 'The assistant in the site'),
    journey,
    facetWrap
  )
}
