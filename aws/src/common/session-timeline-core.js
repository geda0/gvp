// Build an ordered, single-session timeline from raw EVENT rows. Filters to the target
// sessionId and sorts ascending by the client interaction `ts` (preserved per-event),
// with `createdAt` as the tiebreaker/fallback — so a batch of events sharing ONE server
// createdAt still renders in interaction order. SDK-free + pure (no aws/src deps).
export function orderSessionEvents(rows, sessionId) {
  const list = Array.isArray(rows) ? rows : []
  const mine = list.filter((r) => r && r.sessionId === sessionId)
  const tsKey = (r) => (Number.isFinite(r.ts) ? r.ts : 0)
  return mine.slice().sort((a, b) => {
    const ka = tsKey(a)
    const kb = tsKey(b)
    if (ka !== kb) return ka - kb
    const ca = String(a.createdAt || '')
    const cb = String(b.createdAt || '')
    return ca < cb ? -1 : ca > cb ? 1 : 0
  })
}
