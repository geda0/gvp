/**
 * Live-session context notes (ADR-0015 §7).
 *
 * While the visitor is talking to the assistant by voice, the site keeps changing under the
 * conversation — they click a project, open the contact form, navigate. The session was
 * minted with one snapshot of where they were (§6), and without this it stays frozen at that
 * snapshot for the whole call.
 *
 * Pure: no DOM, no WebSocket, no timers of its own. Everything that touches the outside is
 * injected, which is what makes the dedupe and the coalescing assertable at all — and what
 * makes the last rule below true by construction.
 *
 * THE LAST RULE, and it is the important one: THIS MODULE HAS NO WAY TO END A VOICE SESSION.
 * It runs on every site change during a live call, so if it could reach `stopVoice` it would
 * be the single most likely place to reintroduce the defect the whole milestone is about —
 * and it would do so inside the store's notify loop, where the exception handling hides the
 * evidence. It is given a `send`, and nothing else (invariant #20).
 */

/**
 * One line of prose about where the visitor is, or '' when there is nothing to assert.
 *
 * KEPT IN STEP WITH `docker/chat/app/site_state.py` BY A SHARED TABLE
 * (`test/fixtures/site-state-lines.json`), which both suites assert against. The line is
 * produced twice, in two languages — Python into the system instruction, this into the live
 * note — so a live session hears the same fact in two voices. If they drift it hears two
 * DIFFERENT facts about the same site and cannot tell which is current. That exact drift
 * has cost this project four months once already (the two `navigate_to_section` enums), so
 * neither renderer is allowed to change alone.
 *
 * @param {null | {section: string|null, projectId: string|null, projectTitle: string|null,
 *                 contactOpen: boolean, voiceActive: boolean}} wire
 */
export function renderSiteStateLine (wire) {
  if (!wire) return ''
  const parts = []
  if (wire.section) parts.push(`on the ${wire.section} page`)
  if (wire.projectId) {
    const title = String(wire.projectTitle || '').trim() || wire.projectId
    parts.push(`with the "${title}" project open`)
  }
  if (wire.contactOpen) parts.push('with the contact form open')
  // `voiceActive` is on the wire but NOT in the prose: on the live path the model IS the
  // voice session, so saying it is a tautology that costs a clause in every note, and on
  // the text path the composer's two modes are mutually exclusive so it is never true
  // there. It stays on the wire because it is worth persisting on the turn (§6.4).
  if (!parts.length) return ''
  return 'Current site state: the visitor is ' + parts.join(', ') + '.'
}

/** Trailing window. One visitor action can write two fields; one action is one note. */
const COALESCE_MS = 250

/**
 * @param {object} deps
 * @param {() => object} deps.getWireState   the store's wire snapshot, read at FLUSH time
 * @param {() => boolean} deps.isSessionOpen is the live socket OPEN right now
 * @param {(payload: object) => void} deps.send
 * @param {(fn: Function, ms: number) => *} deps.setTimer
 * @param {(id: *) => void} deps.clearTimer
 */
export function createSiteStateNotifier ({ getWireState, isSessionOpen, send, setTimer, clearTimer }) {
  let pending = null
  // The last line ACTUALLY SENT on this session. Not a time window: the failure mode is
  // "the same fact told twice", not "told too often".
  let lastSent = null

  const flush = () => {
    pending = null
    try {
      if (!isSessionOpen()) return
      const wire = getWireState()
      if (!wire || !wire.voiceActive) return
      const line = renderSiteStateLine(wire)
      if (!line || line === lastSent) return
      // lastSent is set BEFORE the send, so a send that throws does not leave the notifier
      // retrying the same line on every subsequent change for the rest of the session.
      lastSent = line
      send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: line }] }],
          // The whole point. A note that consumed a turn would make the assistant reply,
          // interrupting the visitor every time they clicked anything.
          turnComplete: false
        }
      })
    } catch (_) {
      // Fire and forget. This runs inside the store's notify loop (§3.4 catches, but this
      // must not rely on that), and the model gets the truth from the next tool result
      // anyway. Same posture as alerts.py under invariant #14.
    }
  }

  return {
    /** @param {{field: string, from: *, to: *, origin: string}} change */
    onChange (change) {
      // An AGENT-origin change is never notified: the agent already received it in the tool
      // result (§5.1), so telling it again is the double-notify. `origin` is the only thing
      // that can tell the two apart — an agent-caused and a visitor-caused change are
      // byte-identical in the state. 'system' (boot, viewport) is not a fact about the site.
      if (!change || change.origin !== 'visitor') return
      if (pending !== null) clearTimer(pending)
      pending = setTimer(flush, COALESCE_MS)
    },
    /** Called on session open and on stopVoice: a new session has been told nothing. */
    reset () {
      if (pending !== null) clearTimer(pending)
      pending = null
      lastSent = null
    }
  }
}
