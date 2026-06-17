import { nowIso } from './contact-shared.js'

// SDK-FREE smoke-test rollup (unit-tested without aws/src deps). A "smoke test" is
// a real dependency exercise, not a static ok: callers build per-dependency checks
// (each { name, status: 'pass'|'warn'|'fail', latencyMs, detail, cost }) and roll
// them up here. overall = the WORST status across checks (pass < warn < fail); no
// checks => pass. An unknown/missing status is treated as fail (fail-safe), so a
// malformed probe never reads as healthy.
const RANK = { pass: 0, warn: 1, fail: 2 }

export function rollupSmoke(checks = [], depth = 'cheap') {
  const list = Array.isArray(checks) ? checks : []
  let worst = 'pass'
  for (const c of list) {
    const status = c && RANK[c.status] != null ? c.status : 'fail'
    if (RANK[status] > RANK[worst]) worst = status
  }
  return { overall: worst, depth, generatedAt: nowIso(), checks: list }
}

// Time a single dependency probe into a check object. `fn` either resolves (=> pass,
// or returns { status, detail } to signal warn/degraded) or throws (=> fail, with the
// error message as detail). NEVER raises — a probe failure becomes a fail check so the
// rollup stays honest. `now` is injectable for deterministic tests (defaults Date.now).
export async function timedCheck(name, fn, { cost = 'free', now = Date.now } = {}) {
  const start = now()
  try {
    const out = await fn()
    const status = out && out.status ? out.status : 'pass'
    const detail = (out && out.detail) || (typeof out === 'string' ? out : 'ok')
    return { name, status, latencyMs: now() - start, detail, cost }
  } catch (error) {
    return { name, status: 'fail', latencyMs: now() - start, detail: String((error && error.message) || error), cost }
  }
}
