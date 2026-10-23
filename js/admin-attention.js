// M8 item 7 (ADR-0021) — the admin "Attention" strip. A pure view-model over data the
// dashboard already loads, ranked bad → warn → info, each row naming the tab that owns it.
// Only sources that exist today are read; M4's mic-permission and tool facets are not
// invented here. A source that failed to load is itself an item, never a silent all-clear.

const RANK = { bad: 0, warn: 1, info: 2 }
const DAY_MS = 24 * 60 * 60 * 1000

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

export function attentionItems({ contactSummary, health, smoke, chatSummary } = {}, now = Date.now()) {
  const items = []
  const add = (level, text, tab) => items.push({ level, text, tab })

  if (!contactSummary || !health) {
    add('warn', 'Contact pipeline data could not load — refresh to retry.', 'contact')
  } else {
    if (health.apiConfigured === false) add('bad', 'The contact API is not configured.', 'contact')
    const failed = Number(contactSummary.failed || 0)
    if (failed > 0) {
      const latest = contactSummary.mostRecentFailure?.lastError
      add('bad', `${plural(failed, 'contact message', 'contact messages')} failed to send${latest ? ` — latest: ${latest}` : ''}.`, 'contact')
    }
    const dead = Math.max(Number(contactSummary.deadLettered || 0), Number(health.dlqVisible || 0))
    if (dead > 0) add('bad', `${plural(dead, 'contact message is', 'contact messages are')} in the dead-letter queue.`, 'contact')
    if (health.alarmState === 'ALARM') add('bad', 'The contact pipeline alarm is firing.', 'contact')
  }

  if (smoke?.overall === 'fail') add('bad', 'The smoke checks are failing.', 'contact')
  else if (smoke?.overall === 'warn') add('warn', 'A smoke check is warning.', 'contact')

  if (!chatSummary) {
    add('warn', 'Chat transcripts could not load — refresh to retry.', 'transcripts')
  } else {
    const failures = Number(chatSummary.stream?.streamFailures || 0)
    if (failures > 0) {
      const latest = (chatSummary.stream?.recentFailures || [])[0] || {}
      const at = Date.parse(latest.capturedAt || '')
      const fresh = Number.isFinite(at) && now - at < DAY_MS
      const code = latest.errorCode ? ` (latest: ${latest.errorCode})` : ''
      add(fresh ? 'bad' : 'warn', `${plural(failures, 'chat turn', 'chat turns')} failed${code}.`, 'transcripts')
    }
    const unreviewed = Number(chatSummary.unreviewed || 0)
    if (unreviewed > 0) {
      const flagged = Number(chatSummary.flagged || 0)
      add('info', `${plural(unreviewed, 'conversation awaits', 'conversations await')} review${flagged ? ` (${flagged} flagged)` : ''}.`, 'transcripts')
    }
  }

  // Stable sort: within a level the order above (most actionable first) is kept.
  return items.sort((a, b) => RANK[a.level] - RANK[b.level])
}

export function renderAttention(root, items, onOpen) {
  if (!items.length) {
    const ok = document.createElement('p')
    ok.dataset.level = 'ok'
    ok.textContent = 'All clear — nothing needs attention.'
    root.replaceChildren(ok)
    return
  }
  const rows = items.map((item) => {
    const row = document.createElement('div')
    row.dataset.level = item.level
    const text = document.createElement('span')
    text.textContent = item.text
    const open = document.createElement('button')
    open.type = 'button'
    open.textContent = 'Open'
    open.addEventListener('click', () => onOpen(item.tab))
    row.appendChild(text)
    row.appendChild(open)
    return row
  })
  root.replaceChildren(...rows)
}
