// M4 slice 17 (ADR-0017 §8) — the assistant-usage rollup for the admin "Assistant" tab.
// SDK-free: the day query is injected (contact-admin.js binds it to DynamoDB), so this tests
// without node_modules.
//
// Events arrive on a PUBLIC route, so every facet is a CLOSED key space plus 'other' - an
// open-keyed facet would let anyone mint values and own rows of the owner's dashboard
// (invariant #17). Counters are Object.create(null) so 'toString' counts as a number
// (ADR-0020 §5 A7b; test/chat-admin-histogram-keys.test.mjs widens to these names).

const DEFAULT_DAYS = 30
const MAX_DAYS = 90
// Route-specific cap: 90 days x the daily report's 50,000 would be far more than a dashboard needs.
const MAX_ROWS_PER_DAY = 5000

const SURFACES = ['hero', 'event', 'dialog', 'footer', 'launcher', 'chip']
const STOP_REASONS = ['abort_connecting', 'max_session', 'no_mic_idle', 'ws_idle']
const LIVE_ERROR_PHASES = ['start', 'websocket', 'ws_closed_before_ready', 'attach_mic']
const PROJECT_CHIPS = ['summarize', 'more', 'talk']
const SECTIONS = ['home', 'portfolio', 'labs']

const ENGAGED = new Set(['chat_composer_submit', 'chat_voice_start', 'chat_live_start', 'chat_dialog_chip', 'project_assistant_chip', 'selection_assistant_chip'])

export function parseDays (raw) {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_DAYS
  return Math.min(MAX_DAYS, Math.max(1, n))
}

function closedFacet (keys) {
  const facet = Object.create(null)
  for (const k of keys) facet[k] = 0
  facet.other = 0
  return facet
}

function bump (facet, value) {
  const key = typeof value === 'string' && Object.hasOwn(facet, value) && value !== 'other' ? value : 'other'
  facet[key] += 1
}

function dayBack (today, n) {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : 0)

export async function assistantUsage ({ queryDay, days, today = new Date().toISOString().slice(0, 10) }) {
  const window = parseDays(days)
  const totals = { opens: 0, submits: 0, voiceStarts: 0, voiceErrors: 0, voiceStops: 0, launcherResumes: 0, projectChips: 0, selectionOffers: 0, selectionChips: 0 }
  const facets = {
    openSurfaces: closedFacet(SURFACES),
    stopReasons: closedFacet(STOP_REASONS),
    liveErrorPhases: closedFacet(LIVE_ERROR_PHASES),
    projectChips: closedFacet(PROJECT_CHIPS),
    sections: closedFacet(SECTIONS)
  }
  const opened = new Set(); const engaged = new Set(); const voice = new Set(); const voiceErr = new Set()

  for (let i = 0; i < window; i++) {
    const day = dayBack(today, i)
    const rows = await queryDay({ day, maxItems: MAX_ROWS_PER_DAY })
    for (const row of rows || []) {
      const name = row && row.event
      const params = (row && row.params) || {}
      const sid = (row && row.sessionId) || ''
      if (name === 'chat_open') {
        totals.opens += 1
        opened.add(sid)
        bump(facets.openSurfaces, params.surface)
        if (row.section) bump(facets.sections, row.section)
      } else if (name === 'chat_composer_submit') totals.submits += 1
      else if (name === 'chat_live_start') { totals.voiceStarts += 1; voice.add(sid) }
      else if (name === 'chat_live_error') { totals.voiceErrors += 1; voiceErr.add(sid); bump(facets.liveErrorPhases, params.phase) }
      else if (name === 'chat_live_stop') { totals.voiceStops += 1; bump(facets.stopReasons, params.reason) }
      else if (name === 'chat_launcher_resume') totals.launcherResumes += 1
      else if (name === 'project_assistant_chip') { totals.projectChips += 1; bump(facets.projectChips, params.chip) }
      else if (name === 'selection_assistant_offer') totals.selectionOffers += 1
      else if (name === 'selection_assistant_chip') totals.selectionChips += 1
      if (ENGAGED.has(name)) engaged.add(sid)
    }
  }

  const engagedOpened = [...engaged].filter((s) => opened.has(s))
  const voiceOpened = [...voice].filter((s) => opened.has(s))
  const voiceOk = voiceOpened.filter((s) => !voiceErr.has(s))
  const steps = [['opened', opened.size], ['engaged', engagedOpened.length], ['voice', voiceOpened.length], ['voice-ok', voiceOk.length]]
  const journey = steps.map(([step, sessions], i) => ({
    step,
    sessions,
    conversion: i === 0 ? (sessions > 0 ? 1 : 0) : ratio(sessions, steps[i - 1][1])
  }))

  return { days: window, today, totals, journey, facets, maxRowsPerDay: MAX_ROWS_PER_DAY }
}
