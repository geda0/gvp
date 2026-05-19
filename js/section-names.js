/** Map navigation / UI section labels to chat + agent-node buckets. */
export function normalizeSection(section) {
  // Legacy 'playground' bookmarks resolve to portfolio (playground is a
  // subsection under portfolio now). Anything else is 'home'.
  if (section === 'portfolio' || section === 'playground') return 'portfolio'
  return 'home'
}
