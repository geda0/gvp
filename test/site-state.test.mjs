import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getSiteState,
  subscribe,
  setSection,
  setProject,
  setContactOpen,
  setChatStage,
  setVoiceActive,
  __resetSiteStateForTests
} from '../js/site-state.js'

// The observable store M2 is built on (ADR-0015 §3). It replaces the
// `gvp:site-chat-collapse` event, which is how the assistant's own tool calls came to tear
// down the voice session that had just promised the action.
//
// Three things in this contract are load-bearing rather than stylistic, and each is here
// because the ADR argues it from a real failure mode:
//
// 1. NO GENERIC `set(patch)`. One narrow writer per field, and the writer IS the permission
//    (§3.2). A generic setter makes "who may change `voiceActive`?" unanswerable, and
//    `voiceActive` is the field whose spurious writes would resurrect the teardown bug.
//
// 2. `origin` IS MANDATORY (§3.3), and it is the only thing that can separate an
//    agent-caused change from a visitor-caused one. The two are BYTE-IDENTICAL in the state,
//    so no value-based key can tell them apart — which is exactly what §7's live-session
//    dedupe needs: the agent already learned about its own change from the tool result, so
//    re-notifying it is the double-notify the plan mentions.
//
// 3. SUBSCRIBE CALLS BACK IMMEDIATELY with `change === null` (§3.4). Not invented here: it
//    matches `js/chat-bus.js`'s existing convention. Two different subscribe conventions in
//    one codebase is a bug generator.
//
// Also pinned: a frozen snapshot (a reader that writes must THROW, not silently succeed), a
// same-value write is a no-op (the cheap half of dedupe), and one throwing subscriber must
// not break the write or starve the subscribers after it.
//
// `__resetSiteStateForTests` is mandatory, not a convenience: this repo has zero test
// dependencies and `node --test` gives no per-file module isolation, so a module singleton
// without a reset is untestable here.

test.beforeEach(() => __resetSiteStateForTests())

test('the initial state is the documented five fields', () => {
  assert.deepEqual(getSiteState(), {
    section: 'home',
    project: null,
    contactOpen: false,
    chatStage: 'closed',
    voiceActive: false
  })
})

test('each field has its own narrow writer, and there is no generic set()', async () => {
  setSection('portfolio', { origin: 'visitor' })
  setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })
  setContactOpen(true, { origin: 'agent' })
  setChatStage('docked', { origin: 'system' })
  setVoiceActive(true, { origin: 'visitor' })

  assert.deepEqual(getSiteState(), {
    section: 'portfolio',
    project: { id: 'team-tactics', title: 'Team Tactics' },
    contactOpen: true,
    chatStage: 'docked',
    voiceActive: true
  })

  const mod = await import('../js/site-state.js')
  assert.equal(
    typeof mod.set, 'undefined',
    'site-state must NOT export a generic set(patch) — the writer is the permission (§3.2), ' +
    'and a generic setter makes "who may change voiceActive?" unanswerable'
  )
})

test('getSiteState returns a FROZEN snapshot, nested project included', () => {
  setProject({ id: 'gvp', title: 'This site' }, { origin: 'visitor' })
  const snap = getSiteState()

  assert.throws(
    () => { snap.section = 'labs' },
    TypeError,
    'the snapshot must be frozen — a reader that writes has to throw in strict mode, not ' +
    'silently mutate the store'
  )
  assert.throws(
    () => { snap.project.id = 'hijacked' },
    TypeError,
    'the nested project must be frozen too, or the freeze is decorative'
  )
  assert.equal(getSiteState().section, 'home', 'the store itself must be unchanged')
})

test('origin is mandatory on every write', () => {
  const writers = [
    ['setSection', () => setSection('labs')],
    ['setProject', () => setProject({ id: 'x', title: 'X' })],
    ['setContactOpen', () => setContactOpen(true)],
    ['setChatStage', () => setChatStage('modal')],
    ['setVoiceActive', () => setVoiceActive(true)]
  ]
  for (const [name, call] of writers) {
    assert.throws(
      call, /origin/i,
      `${name} accepted a write with no origin. origin is the ONLY discriminator between an ` +
      'agent-caused and a visitor-caused change — they are byte-identical in the state — so ' +
      'an optional origin makes §7 live-session dedupe impossible'
    )
  }
})

test('an unrecognised origin is refused rather than guessed', () => {
  assert.throws(
    () => setSection('labs', { origin: 'somewhere' }), /origin/i,
    'origin must be one of visitor | agent | system; guessing defeats the dedupe it exists for'
  )
})

test('subscribe fires immediately with change === null, matching chat-bus', () => {
  const seen = []
  subscribe((snapshot, change) => seen.push({ section: snapshot.section, change }))

  assert.equal(seen.length, 1, 'subscribe must call back once immediately')
  assert.equal(seen[0].change, null, 'the immediate call carries change === null (§3.4)')
  assert.equal(seen[0].section, 'home')
})

test('a write notifies synchronously with the full change record', () => {
  const seen = []
  subscribe((snapshot, change) => { if (change) seen.push({ snapshot, change }) })

  setSection('portfolio', { origin: 'agent' })

  assert.equal(seen.length, 1, 'notification must be SYNCHRONOUS — no microtask, no batching')
  assert.deepEqual(seen[0].change, {
    field: 'section', from: 'home', to: 'portfolio', origin: 'agent'
  })
  assert.equal(seen[0].snapshot.section, 'portfolio', 'the snapshot must already be updated')
})

test('a same-value write is a no-op: no notify, no change', () => {
  setSection('labs', { origin: 'visitor' })
  const seen = []
  subscribe((_s, change) => { if (change) seen.push(change) })

  setSection('labs', { origin: 'agent' })

  assert.deepEqual(
    seen, [],
    'writing the value it already holds must not notify. This is the cheap half of dedupe; ' +
    'without it a live session gets told about changes that did not happen'
  )
})

test('unsubscribe stops delivery', () => {
  let count = 0
  const off = subscribe((_s, change) => { if (change) count++ })
  setSection('portfolio', { origin: 'visitor' })
  off()
  setSection('labs', { origin: 'visitor' })
  assert.equal(count, 1, 'subscribe must return a working unsubscribe')
})

test('one throwing subscriber breaks neither the write nor the subscribers after it', () => {
  const after = []
  subscribe(() => { throw new Error('subscriber blew up') })
  subscribe((_s, change) => { if (change) after.push(change.field) })

  assert.doesNotThrow(
    () => setContactOpen(true, { origin: 'visitor' }),
    'a throwing subscriber must not propagate into the writer — the store would then be ' +
    'hostage to its least reliable reader'
  )
  assert.equal(getSiteState().contactOpen, true, 'the write must still have landed')
  assert.deepEqual(after, ['contactOpen'], 'later subscribers must still be called')
})

test('project accepts null to clear, and rejects a malformed shape', () => {
  setProject({ id: 'gvp', title: 'This site' }, { origin: 'visitor' })
  setProject(null, { origin: 'visitor' })
  assert.equal(getSiteState().project, null, 'null must clear the project')

  assert.throws(
    () => setProject({ title: 'no id' }, { origin: 'visitor' }), /id/i,
    'project must carry an id — §6.3 makes projectId a record key M4 wants as an admin facet, ' +
    'so it is an identity and gets rejected rather than clamped'
  )
})

test('chatStage refuses a stage outside the documented four', () => {
  assert.throws(
    () => setChatStage('wide', { origin: 'system' }), /stage/i,
    'chatStage is closed | modal | docked | minimized (§4). An unknown stage would reach the ' +
    'reducer and produce chrome nobody specified'
  )
})
