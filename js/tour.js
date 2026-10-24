/**
 * The guided tour (Work-showcase Track C, backlog item 6), as DATA plus one lookup.
 *
 * "Show me around" is a declared tool (`start_tour`); the page runs the tour, the model does
 * not narrate it. Step-on-confirm, the design-notes default: each stop moves the page and says
 * a line or two, then waits for the visitor to tap Next stop - less jarring than a timed
 * scroll, and nobody gets moved while reading. The order leads with the work and ends back at
 * it with a way to get in touch, never at a dead end.
 *
 * The Next stop / End tour controls are NOT per-message buttons: they live in one tour bar in
 * the chat header (js/chat.js), which stays visible when the chat yields to the page as a
 * pill on narrow screens and cannot be re-tapped from a stale message. A step says which stop
 * comes next; only the last stop carries buttons of its own, the way out.
 *
 * The narration is the agent's voice and is the owner's to bless; every claim in it is taken
 * from data/projects.json. Wiring (that a stop really moves the page) is pinned by
 * test/agent-guide.test.mjs, which boots the real chat.js.
 */

const STOPS = [
  {
    section: 'portfolio',
    say: 'First stop, the work: fifteen years of platforms and cloud, at IBM (Apptio), JumpCloud, HP and AT&T. Each card opens what he built and what it changed.'
  },
  {
    section: 'portfolio',
    project: 'apptio',
    say: "Up close: Apptio, an IBM company. He migrated its financial-data pipelines from Java on Kubernetes to EMR Spark with Scala, and proved every byte still added up."
  },
  {
    section: 'labs',
    say: 'Labs is what he builds for himself: Team Tactics, a TDD harness for Claude Code; the AI assistant you are talking to; and a Raspberry Pi rover with on-device vision.'
  },
  {
    section: 'portfolio',
    say: "That's the tour. Want to go deeper on any project, or get in touch with Marwan?",
    end: true
  }
]

export const TOUR_LENGTH = STOPS.length

/**
 * @param {number} index
 * @returns {null | {index: number, say: string,
 *   moves: Array<{kind: 'close-project'} | {kind: 'navigate', section: string} | {kind: 'open-project', project: string}>,
 *   next: number | null,
 *   actions: Array<{id: string, label: string, section?: string}>}}
 */
export function tourStep(index) {
  if (!Number.isInteger(index) || index < 0 || index >= STOPS.length) return null
  const stop = STOPS[index]
  // Every stop starts by closing whatever card is open: a no-op close is a success
  // (js/projects.js), and it means a stop never narrates over the previous stop's card.
  const moves = [{ kind: 'close-project' }, { kind: 'navigate', section: stop.section }]
  if (stop.project) moves.push({ kind: 'open-project', project: stop.project })
  const actions = stop.end
    ? [
        { id: 'open-contact', label: 'Get in touch' },
        { id: 'navigate', section: 'portfolio', label: 'Back to the work' }
      ]
    : []
  return { index, say: stop.say, moves, next: stop.end ? null : index + 1, actions }
}
