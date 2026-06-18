/**
 * Pure helper: derive the assistant reply text to render.
 *
 * The model sometimes fires a tool (open résumé / navigate / contact) with no
 * prose. In that case the bare "try again" fallback used to surface next to the
 * action button — which read as broken. Derive a useful line tied to the action
 * instead, so the response always reads as intended.
 *
 * Kept dependency-free (no DOM, no imports) so it is trivially unit-testable.
 *
 * @param {unknown} reply   raw reply text from the chat backend (may be empty)
 * @param {Array<{id?: string, section?: string}>} [actions]  action descriptors
 * @returns {string} non-empty reply text to render
 */
export function deriveReplyText(reply, actions = []) {
  const safe = String(reply || '').trim()
  if (safe) return safe

  const list = Array.isArray(actions) ? actions : []
  const nav = list.find((x) => x && x.id === 'navigate')
  if (nav) {
    const where =
      nav.section === 'portfolio' ? 'the Portfolio'
        : nav.section === 'labs' ? 'Labs'
          : nav.section === 'home' ? 'Home'
            : 'that section'
    return `Sure — tap below to jump to ${where}, where the work walks through each project.`
  }
  if (list.some((x) => x && x.id === 'open-resume')) {
    return "Here's Marwan's résumé to download — tap below. His work is also laid out right here on the site, so I'm happy to walk you through the Portfolio instead."
  }
  if (list.some((x) => x && x.id === 'open-contact')) {
    return "I've opened the contact form for you below — fire away."
  }
  return 'I do not have a response yet. Please try again.'
}
