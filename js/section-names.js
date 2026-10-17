/**
 * The section vocabulary, as DATA (ADR-0015 §2.1). One module owns it; every consumer is a
 * table lookup.
 *
 * This is the module that makes M2 and the Work-showcase milestone order-independent. §2
 * found TWO live vocabularies — the shipped `home|portfolio|labs` and ADR-0010/0011's
 * accepted-but-never-built `work|experience|contact` — so a third normaliser with its own
 * opinion would mean whichever milestone landed second reworked the first. ADR-0011's rename
 * is now an edit to `SECTION_IDS` + `SECTION_ALIASES` plus the DOM/route work it already
 * owns, and it touches nothing M2 builds.
 *
 * Two resolvers, deliberately, with OPPOSITE postures on an unknown input:
 *   - `normalizeSection` BUCKETS (unknown → home). Its callers label analytics and pick a
 *     knowledge bucket; throwing or refusing there would break a reply over a label.
 *   - `resolveNavTarget` REFUSES. Its caller moves the visitor's page, and navigating
 *     someone to the wrong place must never be silent.
 */

/** The shipped registry. `siteState.section` is contractually a member of this. */
export const SECTION_IDS = ['home', 'portfolio', 'labs']

/**
 * Legacy and future renames land HERE, never in a branch.
 * `playground` is the top-level page's former name — accepted as INPUT so old bookmarks and
 * stored state keep working, and advertised NOWHERE (a tool declaration that offers it
 * teaches the model a section the site does not have).
 */
export const SECTION_ALIASES = { playground: 'labs' }

/** Home is the base URL, not a route — js/navigation.js restores path+search for it. */
const SECTION_HASHES = { home: '', portfolio: '#portfolio', labs: '#labs' }

/** Map navigation / UI section labels to chat + agent-node buckets. */
export function normalizeSection(section) {
  if (SECTION_ALIASES[section]) return SECTION_ALIASES[section]
  if (SECTION_IDS.includes(section)) return section
  return 'home'
}

/**
 * Resolve whatever the agent said into a target the router understands.
 *
 * Normalises BEFORE matching, which is the whole point: the shipped chain compared bytes
 * (`js/chat.js` pre-M2), so `"Portfolio"` — the capitalisation a model naturally uses for a
 * page called Portfolio — fell through to `unknown_section`, and on the text path the error
 * was discarded, making it silent to everyone.
 *
 * @param {unknown} raw
 * @returns {{id: string, hash: string} | {error: 'unknown_section', received: unknown}}
 */
export function resolveNavTarget(raw) {
  // Refused rather than coerced: `String(null)` is `'null'` and `String([])` is `''`, so a
  // blind coercion turns a caller bug into a plausible lookup miss.
  if (typeof raw !== 'string') return { error: 'unknown_section', received: raw }
  const key = raw.trim().toLowerCase()
  const id = SECTION_ALIASES[key] || (SECTION_IDS.includes(key) ? key : null)
  if (!id) return { error: 'unknown_section', received: raw }
  return { id, hash: SECTION_HASHES[id] }
}
