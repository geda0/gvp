/**
 * Observable site state (ADR-0015 §3) — the seam M2 is built on.
 *
 * Replaces the `gvp:site-chat-collapse` event. That event is how the assistant's own
 * `navigate_to_section` / `open_contact_form` came to tear down the live voice session that
 * had just promised the action: an event says "collapse the chat", so every listener could
 * only obey. State says "the visitor is now on portfolio", and the chat decides what that
 * means for itself.
 *
 * Three parts of this contract are load-bearing rather than stylistic:
 *
 * 1. NO GENERIC `set(patch)`. One narrow writer per field, and the writer IS the permission
 *    (§3.2). With a generic setter, "who may change `voiceActive`?" has no answer — and
 *    `voiceActive` is precisely the field whose spurious writes would resurrect the bug.
 *
 * 2. `origin` IS MANDATORY (§3.3). An agent-caused change and a visitor-caused one are
 *    BYTE-IDENTICAL in the state, so no value-based comparison can separate them. `origin`
 *    is the only discriminator, and §7's live-session notes need it: the agent already
 *    learned about its own change from the tool result, so re-notifying it is a double-notify.
 *
 * 3. `subscribe` CALLS BACK IMMEDIATELY with `change === null`, matching the existing
 *    `js/chat-bus.js` convention rather than inventing a second one.
 *
 * Module singleton, like `js/chat-bus.js`. `__resetSiteStateForTests()` is mandatory, not a
 * convenience: this repo has zero test dependencies and `node --test` gives no per-file
 * module isolation, so a singleton without a reset is untestable here.
 */

/** @typedef {'visitor' | 'agent' | 'system'} Origin */

const ORIGINS = new Set(['visitor', 'agent', 'system'])

/** The four stages the reducer (§4) is defined over. */
export const CHAT_STAGES = ['closed', 'modal', 'docked', 'minimized']

const initial = () => ({
  section: 'home',
  project: null,
  contactOpen: false,
  chatStage: 'closed',
  voiceActive: false
})

let state = initial()
let subscribers = []

function assertOrigin (opts, writer) {
  const origin = opts && opts.origin
  if (!origin) {
    throw new TypeError(
      `${writer}: origin is required (visitor | agent | system). It is the only thing that ` +
      'separates an agent-caused change from a visitor-caused one — they are identical in ' +
      'the state — so an optional origin makes live-session dedupe impossible.'
    )
  }
  if (!ORIGINS.has(origin)) {
    throw new TypeError(
      `${writer}: unknown origin ${JSON.stringify(origin)}; expected visitor | agent | system`
    )
  }
  return origin
}

/** Frozen snapshot, nested project included, so a reader cannot mutate the store. */
function snapshot () {
  const project = state.project
    ? Object.freeze({ id: state.project.id, title: state.project.title })
    : null
  return Object.freeze({ ...state, project })
}

export function getSiteState () {
  return snapshot()
}

/**
 * @param {(snapshot: object, change: null | {field: string, from: *, to: *, origin: Origin}) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe (fn) {
  if (typeof fn !== 'function') throw new TypeError('subscribe expects a function')
  subscribers.push(fn)
  // Immediate call with change === null, per chat-bus's convention.
  notifyOne(fn, null)
  return () => { subscribers = subscribers.filter((s) => s !== fn) }
}

function notifyOne (fn, change) {
  try {
    fn(snapshot(), change)
  } catch (_) {
    // A throwing subscriber must not break the write or starve the subscribers after it —
    // the store would otherwise be hostage to its least reliable reader.
  }
}

function commit (field, value, origin) {
  const from = state[field]
  // A same-value write is a no-op: no notify, no change record. This is the cheap half of
  // dedupe; without it a live session is told about changes that did not happen.
  if (sameValue(from, value)) return
  state = { ...state, [field]: value }
  const change = Object.freeze({ field, from, to: value, origin })
  for (const fn of [...subscribers]) notifyOne(fn, change)
}

function sameValue (a, b) {
  if (a === b) return true
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return a.id === b.id && a.title === b.title
  }
  return false
}

export function setSection (id, opts) {
  const origin = assertOrigin(opts, 'setSection')
  if (typeof id !== 'string' || !id) throw new TypeError('setSection: section id must be a non-empty string')
  commit('section', id, origin)
}

export function setProject (project, opts) {
  const origin = assertOrigin(opts, 'setProject')
  if (project !== null) {
    if (!project || typeof project !== 'object') {
      throw new TypeError('setProject: expected an object or null')
    }
    if (typeof project.id !== 'string' || !project.id) {
      // Rejected, not clamped: §6.3 treats projectId as an IDENTITY (a record key M4 wants
      // as an admin facet), and the rule is clamp values, reject identities.
      throw new TypeError('setProject: project.id is required')
    }
  }
  commit('project', project === null ? null : { id: project.id, title: String(project.title ?? '') }, origin)
}

export function setContactOpen (open, opts) {
  const origin = assertOrigin(opts, 'setContactOpen')
  commit('contactOpen', Boolean(open), origin)
}

export function setChatStage (stage, opts) {
  const origin = assertOrigin(opts, 'setChatStage')
  if (!CHAT_STAGES.includes(stage)) {
    throw new TypeError(
      `setChatStage: unknown stage ${JSON.stringify(stage)}; expected one of ${CHAT_STAGES.join(' | ')}`
    )
  }
  commit('chatStage', stage, origin)
}

export function setVoiceActive (active, opts) {
  const origin = assertOrigin(opts, 'setVoiceActive')
  commit('voiceActive', Boolean(active), origin)
}

// ------------------------------------------------------------------ the wire shape (§6.1)
//
// Caps live here as module-private constants and are asserted from the OUTSIDE as behaviour
// (test/site-state-wire.test.mjs), the discipline turn_input.py uses under invariant #17: a
// bound and the test that pins it cannot then be changed in one edit.
const MAX_SECTION = 32
const MAX_PROJECT_ID = 64
const MAX_PROJECT_TITLE = 120

// The SHAPES docker/chat/app/site_state.py accepts. Length alone is not enough: the server
// rejects on charset too, and a rejection is a 400 for the WHOLE request on both routes
// (ss6.2 chose reject-not-clamp for identities, correctly). So one project id with a space
// in it would take the chat down - text and voice - for as long as that card is open, with
// both suites green, because each side is individually right. A value this side cannot
// vouch for is DROPPED: a missing field costs the model one fact, a 400 costs the visitor
// the whole conversation. test/site-state-producer-matches-validator.test.mjs reads these
// patterns out of the Python rather than trusting this copy.
const SECTION_SHAPE = /^[a-z][a-z0-9-]{0,31}$/
const PROJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The five flat keys the server sees. ONE conversion, in the module that owns the state —
 * the tool-result echo (§5.1), the /api/chat body and the /api/live/session request all call
 * this. Each caller flattening the store itself is how `providers.py` and `live_gemini.py`
 * came to declare two different section enums.
 *
 * Flat and depth 1 BY CONSTRUCTION, so the server needs no recursive walk to bound the
 * shape. `chatStage` is deliberately absent: no model action depends on whether its own
 * window is docked or minimized.
 *
 * #17's rule — CLAMP VALUES, REJECT IDENTITIES — decides the caps. `projectTitle` is the one
 * free-text value, so it truncates. `section` and `projectId` are identities (an enum key
 * and a record key M4 wants as an admin facet), so an over-long one is DROPPED rather than
 * shortened: a shortened id is a plausible id for a different record, which the server would
 * accept as real. Dropping loses a fact; truncating invents one.
 */
export function getSiteStateForWire () {
  const section = typeof state.section === 'string'
    && state.section.length <= MAX_SECTION
    && SECTION_SHAPE.test(state.section)
    ? state.section
    : null
  const id = state.project && state.project.id
  const projectId = typeof id === 'string'
    && id.length <= MAX_PROJECT_ID
    && PROJECT_ID_SHAPE.test(id)
    ? id
    : null
  return {
    section,
    projectId,
    projectTitle: state.project ? String(state.project.title ?? '').slice(0, MAX_PROJECT_TITLE) : null,
    contactOpen: state.contactOpen,
    voiceActive: state.voiceActive
  }
}

/**
 * The wire snapshot, or null when it says nothing the model could not assume.
 *
 * ss6.2 makes ABSENT meaningful: the server omits the "Current site state" line entirely
 * rather than defaulting it, so the model is never told a fact nobody asserted. Sending the
 * default state on every turn would spend prompt tokens saying "the visitor is on home with
 * nothing open" - which is what it would assume anyway.
 *
 * Here rather than at each call site, because /api/chat and /api/live/session must agree:
 * two copies of "is this worth saying" is how two paths come to disagree about the same
 * visitor.
 */
export function siteStateWireIfNotable () {
  const wire = getSiteStateForWire()
  const notable = (wire.section && wire.section !== 'home')
    || wire.projectId || wire.contactOpen || wire.voiceActive
  return notable ? wire : null
}

/** Test-only reset. Mandatory — see the module note on module isolation. */
export function __resetSiteStateForTests () {
  state = initial()
  subscribers = []
}
