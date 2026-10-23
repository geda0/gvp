import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getSiteStateForWire,
  setSection,
  setProject,
  setContactOpen,
  setChatStage,
  setVoiceActive,
  __resetSiteStateForTests
} from '../js/site-state.js'

// The wire shape (ADR-0015 §6.1). One conversion, in the module that owns the state, used by
// every caller: the tool-result echo (§5.1), the /api/chat body, and the /api/live/session
// request. The alternative — each caller flattening the store itself — is how `providers.py`
// and `live_gemini.py` came to declare two different section enums (§9.3).
//
// FIVE KEYS, FLAT, DEPTH 1 BY CONSTRUCTION. That is not tidiness: invariant #17 requires a
// bound on SHAPE, and a flat five-key object has a provable depth of 1 and needs no recursive
// walk to establish it. The nested `project` stays nested in the STORE because that is
// ergonomic in JS; the flattening happens here, at the seam.
//
// TWO DELIBERATE DIFFERENCES FROM THE STORE, each with a reason the ADR records:
//   - chatStage is NOT on the wire. No model action depends on whether its own window is
//     docked or minimized, so it would be key space and prompt tokens for nothing. Adding it
//     later is additive and needs no ADR.
//   - project is FLATTENED to projectId + projectTitle.
//
// THE CAPS ARE ASSERTED FROM THE OUTSIDE, as behaviour — the same discipline turn_input.py
// uses under #17 — so a bound and the test that pins it cannot be changed in one edit.

test.beforeEach(() => __resetSiteStateForTests())

test('the wire shape is the five flat keys, and nothing else', () => {
  setSection('portfolio', { origin: 'visitor' })
  setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })
  setContactOpen(false, { origin: 'visitor' })
  setVoiceActive(true, { origin: 'system' })
  setChatStage('docked', { origin: 'system' })

  assert.deepEqual(getSiteStateForWire(), {
    section: 'portfolio',
    projectId: 'team-tactics',
    projectTitle: 'Team Tactics',
    contactOpen: false,
    voiceActive: true
  })
})

test('chatStage never reaches the wire', () => {
  setChatStage('minimized', { origin: 'system' })
  assert.equal(
    'chatStage' in getSiteStateForWire(), false,
    'the model has no action that depends on whether its own window is docked or minimized ' +
    '(§6.1). Shipping it is key space and prompt tokens for nothing'
  )
})

test('no project means both project keys are null, not absent and not empty strings', () => {
  setSection('home', { origin: 'visitor' })
  const wire = getSiteStateForWire()
  assert.equal(wire.projectId, null)
  assert.equal(
    wire.projectTitle, null,
    'null says "no project open". An empty string says "a project with no title", which is a ' +
    'different claim, and the server would have to guess which one the frontend meant'
  )
})

test('the wire object is depth 1 — the bound #17 asks for, by construction', () => {
  setProject({ id: 'gvp', title: 'This site' }, { origin: 'visitor' })
  const wire = getSiteStateForWire()
  for (const [k, v] of Object.entries(wire)) {
    assert.ok(
      v === null || typeof v !== 'object',
      `${k} is an object. Depth must be provable by construction (§6.1/§6.3), so the server ` +
      'needs no recursive walk to establish it'
    )
  }
  assert.ok(
    JSON.stringify(wire).length <= 512,
    'the serialized bound is ≤512 bytes, DERIVED by adding the field caps (32 + 64 + 120 ' +
    'plus five fixed keys and punctuation), not measured. If the caps change, redo the addition'
  )
})

test('projectTitle is CLAMPED, because it is the only free text', () => {
  setProject({ id: 'x', title: 'T'.repeat(400) }, { origin: 'visitor' })
  const wire = getSiteStateForWire()
  assert.equal(
    wire.projectTitle.length, 120,
    '#17\'s rule is CLAMP VALUES, REJECT IDENTITIES. projectTitle is the one free-text value ' +
    'here, so it truncates rather than failing the request'
  )
})

test('an over-long identity is NOT silently truncated into a different identity', () => {
  // The other half of #17's rule. section is an enum key and projectId is a record key M4
  // wants as an admin facet; truncating either makes two distinct callers collide into one
  // bucket, which is the exact failure #17 names.
  setProject({ id: 'p'.repeat(200), title: 'Long id' }, { origin: 'visitor' })
  const wire = getSiteStateForWire()
  assert.equal(
    wire.projectId, null,
    'an id past the cap must be DROPPED, not shortened. A shortened id is a plausible-looking ' +
    'id for a different record, and the server would accept it as real. Dropping it loses one ' +
    'fact; truncating it invents one'
  )
  assert.equal(
    wire.projectTitle, 'Long id',
    'and dropping the id must not take the rest of the state with it — the section, the form ' +
    'and the voice flag are still true'
  )
})

test('a section outside the registry still goes on the wire, verbatim', () => {
  // THE MIGRATION NOTE (§6.2), and it is the one rule here that is about availability rather
  // than correctness. The frontend and the chat host deploy independently, and Amplify serves
  // main's HTML as-is (invariant #11), so skew is real and has caused an incident. A rename
  // reaches one side before the other. A client that refused to send an unrecognised section
  // — or a server that 400s one — turns an IA rename into a site-wide chat outage. The value
  // is already bounded in length and charset; checking it against an enum buys nothing.
  setSection('work', { origin: 'visitor' })
  assert.equal(getSiteStateForWire().section, 'work')
})
