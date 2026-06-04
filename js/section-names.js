/** Map navigation / UI section labels to chat + agent-node buckets. */
export function normalizeSection(section) {
  // 'labs' is the top-level page formerly known as the playground subsection.
  // Legacy 'playground' bookmarks/state resolve to the Labs bucket. Portfolio is
  // its own bucket; anything else is 'home'.
  if (section === 'labs' || section === 'playground') return 'labs'
  if (section === 'portfolio') return 'portfolio'
  return 'home'
}
