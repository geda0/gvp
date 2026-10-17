import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  renderSiteStateLine,
  createSiteStateNotifier
} from '../js/site-state-notes.js'

// Live-session context notes (ADR-0015 §7). While the visitor is talking to the assistant
// by voice, the site keeps changing under the conversation — they click a project, open the
// contact form, navigate. The session was minted with one snapshot of where they were, and
// without this it stays frozen at that snapshot for the whole call.
//
// THE TWO TRIGGER CONDITIONS, and the second is the subtle one:
//   voiceActive === true      — no session, nothing to tell.
//   change.origin === 'visitor' — an AGENT-origin change is NEVER notified. The agent
//   already received it in the tool result (§5.1), so notifying it is the double-notify.
//   'system' (boot, viewport) is not notified either: boot cannot coexist with an open
//   session, and a resize is not a fact about the site.
//
// TWO DEDUPE MECHANISMS, because one is not enough and they catch different things:
//   1. The store's same-value no-op (§3.4) — a write that changes nothing never notifies.
//   2. The rendered LINE compared against the last line actually sent on this session.
//      This catches what (1) cannot: two DIFFERENT writes that land on the same rendered
//      state, e.g. contact-close then project-close both re-rendering "on the portfolio
//      page". Not a time window — the failure mode is "the same fact told twice", not
//      "told too often".
//
// COALESCED ON A TRAILING 250ms WINDOW, carrying the WHOLE line rather than per-field
// deltas. One nav click can write `section` AND `project: null`; two notes for one visitor
// action IS the double-notify, and a whole-state line is idempotent by construction.
//
// FIRE AND FORGET. The notifier must never throw into the store's notify loop (§3.4 catches,
// but it must not rely on that), must NEVER call stopVoice (invariant #20), and must drop
// the note silently when the socket is not OPEN — it is a courtesy, and the model gets the
// truth from the next tool result anyway. Same posture as alerts.py under invariant #14.

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/site-state-lines.json', import.meta.url)), 'utf8')
)

test('the rendered line matches the shared table, row for row', () => {
  // The SAME table docker/chat/tests/test_site_state.py asserts against. The line is
  // produced twice, in two languages — Python into the system instruction, JS into the
  // live note — so a live session hears the same fact in two voices. If they drift it hears
  // two DIFFERENT facts about the same site and has no way to tell which is current. That
  // drift has already cost this project four months once (the navigate_to_section enums,
  // §9.3); this is the same fix made before the drift instead of after it.
  const wrong = []
  for (const c of FIXTURE.cases) {
    const got = renderSiteStateLine(c.wire)
    if (got !== c.line) wrong.push(`${c.name}:\n    got      ${JSON.stringify(got)}\n    expected ${JSON.stringify(c.line)}`)
  }
  assert.deepEqual(wrong, [], 'renderer disagrees with the shared table:\n  ' + wrong.join('\n  '))
})

// ---------------------------------------------------------------- the notifier

function harness ({ voiceActive = true } = {}) {
  const sent = []
  let open = true
  let state = { section: 'home', projectId: null, projectTitle: null, contactOpen: false, voiceActive }
  let now = 0
  const timers = []
  const notifier = createSiteStateNotifier({
    getWireState: () => state,
    isSessionOpen: () => open,
    send: (payload) => { sent.push(payload) },
    setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length - 1 },
    clearTimer: (id) => { if (timers[id]) timers[id].fn = null }
  })
  const advance = (ms) => {
    now += ms
    for (const t of timers) {
      if (t.fn && t.at <= now) { const fn = t.fn; t.fn = null; fn() }
    }
  }
  return {
    sent,
    notifier,
    advance,
    setState: (patch) => { state = { ...state, ...patch } },
    closeSocket: () => { open = false }
  }
}

const textOf = (payload) => payload.clientContent.turns[0].parts[0].text

test('a visitor-caused change while voice is live produces one note', () => {
  const h = harness()
  h.setState({ section: 'portfolio' })
  h.notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'visitor' })
  h.advance(250)

  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0], {
    clientContent: {
      turns: [{ role: 'user', parts: [{ text: 'Current site state: the visitor is on the portfolio page.' }] }],
      turnComplete: false
    }
  })
  assert.equal(
    h.sent[0].clientContent.turnComplete, false,
    'turnComplete:false is the whole point — the note must not consume a turn or provoke a ' +
    'reply. A note that made the assistant answer would interrupt the visitor mid-sentence ' +
    'every time they clicked anything'
  )
})

test('an AGENT-caused change is never notified', () => {
  const h = harness()
  h.setState({ section: 'labs' })
  h.notifier.onChange({ field: 'section', from: 'home', to: 'labs', origin: 'agent' })
  h.advance(500)
  assert.deepEqual(
    h.sent, [],
    'the agent already received this in the tool result (§5.1). Telling it again is the ' +
    'double-notify, and origin is the ONLY thing that can tell the two apart — an ' +
    'agent-caused and a visitor-caused change are byte-identical in the state'
  )
})

test('a system-origin change is not notified either', () => {
  const h = harness()
  h.setState({ section: 'portfolio' })
  h.notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'system' })
  h.advance(500)
  assert.deepEqual(
    h.sent, [],
    'boot cannot coexist with an open session, and a resize is not a fact about the site'
  )
})

test('nothing is sent when no voice session is live', () => {
  const h = harness({ voiceActive: false })
  h.setState({ section: 'portfolio' })
  h.notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'visitor' })
  h.advance(500)
  assert.deepEqual(h.sent, [], 'no session, nothing to tell')
})

test('several writes from one visitor action coalesce into ONE whole-state note', () => {
  const h = harness()
  // Exactly what one nav click does: js/navigation.js writes the section, and the project
  // dialog that was open closes behind it.
  h.setState({ section: 'portfolio', projectId: null, projectTitle: null })
  h.notifier.onChange({ field: 'section', from: 'labs', to: 'portfolio', origin: 'visitor' })
  h.notifier.onChange({ field: 'project', from: { id: 'x' }, to: null, origin: 'visitor' })
  h.advance(250)

  assert.equal(
    h.sent.length, 1,
    'two notes for one visitor action IS the double-notify. The window carries the WHOLE ' +
    'line, not per-field deltas, which makes it idempotent by construction'
  )
  assert.match(textOf(h.sent[0]), /portfolio page\.$/)
})

test('the same rendered line is never sent twice on one session', () => {
  const h = harness()
  // Two DIFFERENT writes that land on the same rendered state. The store's same-value
  // no-op (§3.4) cannot see this: both writes genuinely changed a field.
  h.setState({ section: 'portfolio', contactOpen: true })
  h.notifier.onChange({ field: 'contactOpen', from: false, to: true, origin: 'visitor' })
  h.advance(250)
  const first = h.sent.length

  h.setState({ contactOpen: false })
  h.notifier.onChange({ field: 'contactOpen', from: true, to: false, origin: 'visitor' })
  h.advance(250)
  h.setState({ projectId: null, projectTitle: null })
  h.notifier.onChange({ field: 'project', from: { id: 'x' }, to: null, origin: 'visitor' })
  h.advance(250)

  assert.equal(first, 1)
  assert.equal(
    h.sent.length, 2,
    'the second and third both re-render "on the portfolio page", and only one of them may ' +
    'be sent. The dedupe key is the rendered LINE against the last one actually sent — not ' +
    'a time window, because the failure mode is "the same fact told twice"'
  )
})

test('the dedupe memory resets with the session', () => {
  const h = harness()
  h.setState({ section: 'portfolio' })
  h.notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'visitor' })
  h.advance(250)

  h.notifier.reset()

  h.notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'visitor' })
  h.advance(250)
  assert.equal(
    h.sent.length, 2,
    'a NEW session has never been told anything, so the first note must go out even if it ' +
    'repeats the last line of the previous one. Reset on session open and on stopVoice'
  )
})

test('an empty line is never sent', () => {
  const h = harness()
  h.setState({ section: null, projectId: null, projectTitle: null, contactOpen: false })
  h.notifier.onChange({ field: 'section', from: 'portfolio', to: null, origin: 'visitor' })
  h.advance(250)
  assert.deepEqual(h.sent, [], 'there is nothing to say, so nothing is said')
})

test('a closed socket drops the note SILENTLY and never throws', () => {
  const h = harness()
  h.closeSocket()
  h.setState({ section: 'portfolio' })
  assert.doesNotThrow(() => {
    h.notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'visitor' })
    h.advance(250)
  }, 'the notifier runs inside the store\'s notify loop; a throw there would break the write')
  assert.deepEqual(h.sent, [], 'it is a courtesy — the model gets the truth from the next tool result')
})

test('a throwing send is swallowed, and the notifier keeps working', () => {
  const sent = []
  let blowUp = true
  const notifier = createSiteStateNotifier({
    getWireState: () => ({ section: 'portfolio', projectId: null, projectTitle: null, contactOpen: false, voiceActive: true }),
    isSessionOpen: () => true,
    send: (p) => { if (blowUp) throw new Error('socket went away'); sent.push(p) },
    setTimer: (fn) => { fn(); return 0 },
    clearTimer: () => {}
  })
  assert.doesNotThrow(() => notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'visitor' }))
  blowUp = false
  notifier.reset()
  notifier.onChange({ field: 'section', from: 'home', to: 'portfolio', origin: 'visitor' })
  assert.equal(sent.length, 1, 'one failed send must not poison the notifier for the session')
})

test('the notifier has no way to end a voice session', () => {
  // Invariant #20, structurally. This thing runs on every site change during a live call;
  // if it could reach stopVoice it would be the single most likely place to reintroduce the
  // whole defect, and it would do so inside the store's notify loop where the exception
  // handling hides the evidence.
  //
  // A CALL, not a mention. The first version of this row matched the bare word, and the
  // comment on `reset()` — which documents that it is called ON stopVoice — tripped it. A
  // test that cannot tell "names the thing" from "does the thing" fails for the wrong
  // reason, and the fix for that failure is to delete the explanation.
  const src = createSiteStateNotifier.toString() + renderSiteStateLine.toString()
  assert.doesNotMatch(
    src, /\bstopVoice\s*\(|\.close\s*\(|\bterminate\s*\(/,
    'the notifier must not be able to end the session'
  )
  assert.equal(
    /\bsend\s*\(/.test(src), true,
    'and the positive control: it must still be able to SEND, or this row passes by being ' +
    'a module that does nothing'
  )
})
