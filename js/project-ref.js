/**
 * Turning what the model said into a project the site actually has (ADR-0017 §3.2).
 *
 * Same leaf-plus-registry shape as `js/section-names.js`, with ONE deliberate difference:
 * the section registry is a hard-coded constant because the site has three sections and
 * they are structural, while the project registry is CONTENT loaded at runtime. So it is
 * INJECTED here, never imported — a pure leaf that reached into `js/projects.js`'s
 * module-level Map would not be pure, and injection makes this testable with a three-row
 * fixture instead of a DOM.
 *
 * NO FUZZY MATCHING. Same ruling as ADR-0015 §5.2's rejection of `inferPromisedNavigation`,
 * one layer down. A loose match over titles that include "AI assistant & chatbot" and
 * "Generative Video Platform" picks the wrong card for "tell me about the video one" — and
 * opening the WRONG project is a worse failure than reporting that you could not find it,
 * because the model can ask a follow-up and the visitor cannot un-see a card they did not
 * want. Exact and case-folded matches only.
 */

const norm = (v) => String(v).trim().toLowerCase()

/**
 * @param {unknown} raw  an id or a title, as the model said it
 * @param {Iterable<{id: string, title: string}>} registry
 * @returns {{id: string, title: string} | {error: 'unknown_project', received: unknown}}
 */
export function resolveProjectRef (raw, registry) {
  const miss = { error: 'unknown_project', received: raw }
  if (typeof raw !== 'string' || !raw.trim()) return miss

  // Own, shaped entries only. The registry is built from content, so a malformed row is a
  // real possibility rather than a hypothetical — and before the cards render it is empty,
  // where refusing beats throwing (which would take out the tool call) and beats guessing
  // (which would open a card that does not exist yet). Iterating the rows rather than
  // indexing an object also means a key like `constructor` cannot reach the prototype
  // chain, which is the defect js/section-names.js carries a comment about.
  const rows = []
  if (registry && typeof registry !== 'string'
    && typeof registry[Symbol.iterator] === 'function') {
    for (const row of registry) {
      if (!row || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || !row.id) continue
      rows.push({ id: row.id, title: typeof row.title === 'string' ? row.title : '' })
    }
  }
  if (!rows.length) return miss

  const key = norm(raw)
  // IDS BEFORE TITLES, so a registry where one project's title is another's id resolves by
  // the rule rather than by iteration order.
  return rows.find((r) => r.id === raw)
    || rows.find((r) => norm(r.id) === key)
    || rows.find((r) => r.title === raw)
    || rows.find((r) => norm(r.title) === key)
    || miss
}
