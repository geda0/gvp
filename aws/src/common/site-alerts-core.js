// M7 (ADR-0020 amendment) — classify ingested visitor events into operational alerts and
// build the Tier-1 line a CloudWatch metric filter keys on (the same two-tier shape as the
// chat hosts' CHAT_ALERT line, invariant 19). Pure: no @aws-sdk, no I/O.
//
// /api/events is public and anonymous, so this is an ALLOWLIST. Only the constants below and
// an integer status ever reach the line; a forged discriminator is simply not an alert.
// Priority is a static property of the alert type (ADR-0020: one type = one priority).

export const SITE_ALERT_PREFIX = 'SITE_ALERT event='

// type -> { prio, field, values }. `values` is the discriminator allowlist; a status `code`
// qualifies when it is an integer >= 500.
const RULES = {
  contact_submit_error: { prio: 'P1', field: 'reason', values: ['network', 'unexpected_reply'], serverCode: true },
  chat_live_error: { prio: 'P1', field: 'phase', values: ['start', 'websocket', 'ws_closed_before_ready'] },
  chat_live_blocked: { prio: 'P2', field: 'reason', values: ['voice_host_endpoint'] }
}

const ENV_SHAPE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

export function classifySiteAlert(row) {
  const rule = row && Object.hasOwn(RULES, row.event) ? RULES[row.event] : null
  if (!rule) return null
  const params = row.params || {}
  const code = params.code
  if (rule.serverCode && Number.isInteger(code) && code >= 500 && code <= 599) {
    return { type: row.event, prio: rule.prio, detail: `code=${code}` }
  }
  const value = params[rule.field]
  if (rule.values.includes(value)) {
    return { type: row.event, prio: rule.prio, detail: `${rule.field}=${value}` }
  }
  return null
}

export function siteAlertLines(rows, env) {
  const label = ENV_SHAPE.test(env || '') ? env : 'unknown'
  const lines = []
  for (const row of rows || []) {
    const alert = classifySiteAlert(row)
    if (alert) lines.push(`${SITE_ALERT_PREFIX}${alert.type} prio=${alert.prio} env=${label} ${alert.detail}`)
  }
  return lines
}
