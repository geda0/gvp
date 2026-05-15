/** Map navigation / UI section labels to chat + agent-node buckets. */
export function normalizeSection(section) {
  return section === 'playground' || section === 'portfolio' ? section : 'home'
}
