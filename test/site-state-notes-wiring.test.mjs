import test from 'node:test'
import assert from 'node:assert/strict'

import { settle, bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'

// Is the notifier actually CONNECTED to a live session? (ADR-0015 §7)
//
// test/site-state-notes.test.mjs pins the notifier's logic against injected dependencies.
// It cannot tell you that anything ever calls it — which is the failure this repo has
// already shipped once behind a green suite (the defined-but-never-called helper whose
// post-mortem is in test/starfield-depth-wiring.test.mjs). So every row here drives a real
// store write and reads what actually went out over the fake WebSocket.
//
// THE NOTE MUST NOT LOOK LIKE A TURN. `turnComplete: false` is what keeps the model from
// answering it; a note that provoked a reply would interrupt the visitor every time they
// clicked anything, which is a worse bug than the one it fixes.

// The coalescing window is a REAL 250 ms timer in production (js/site-state-notes.js), and
// this file drives the real one on purpose: settle() only yields macrotasks, it does not
// advance the clock, so a note scheduled 250 ms out never arrives inside it. The window's
// LOGIC is pinned with an injected clock in test/site-state-notes.test.mjs; here the point
// is that the wiring fires at all, and paying ~300 ms once for that is the honest price.
const afterTheWindow = async () => {
  await new Promise((resolve) => setTimeout(resolve, 320))
  await settle(10)
}

const sentMessages = (socket) => socket.sent.map((p) => JSON.parse(p))
const notes = (socket) => sentMessages(socket).filter((m) => m.clientContent)
const noteText = (m) => m.clientContent.turns[0].parts[0].text

test('a visitor navigating during a live call tells the assistant where they went', async (t) => {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, socket, nav } = await bootChatWithLiveVoice({ tag: 'notes-wire' })
  t.after(() => api.disposeChatLiveVoice())

  assert.equal(api.liveVoice.isSessionOpen(), true, 'harness: the session must be up')
  socket.sent.length = 0

  // Through the real router, the way a nav click does it.
  nav.requestNavigation('portfolio', { origin: 'visitor' })
  await afterTheWindow()

  const out = notes(socket)
  assert.equal(out.length, 1, `expected one note, saw ${JSON.stringify(socket.sent)}`)
  assert.match(noteText(out[0]), /portfolio/)
  assert.equal(
    out[0].clientContent.turnComplete, false,
    'the note must not consume a turn — a reply here interrupts the visitor mid-click'
  )
})

test("the assistant's OWN navigation is not read back to it", async (t) => {
  // The dedupe (§3.3/§7.1). The agent already received this in the tool result, and origin
  // is the only thing that can tell an agent-caused change from a visitor-caused one —
  // they are byte-identical in the state.
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'notes-agent' })
  t.after(() => api.disposeChatLiveVoice())
  socket.sent.length = 0

  socket.onmessage({
    data: JSON.stringify({
      toolCall: { functionCalls: [{ id: 'c1', name: 'navigate_to_section', args: { section: 'labs' } }] }
    })
  })
  await afterTheWindow()

  const responses = sentMessages(socket).filter((m) => m.toolResponse)
  assert.equal(responses.length, 1, 'harness: the tool must have run, or this proves nothing')
  assert.deepEqual(
    notes(socket), [],
    'the tool result already carried the new state (§5.1). A note on top of it is the ' +
    'double-notify — the model hears the same fact twice and has to work out whether ' +
    'something changed again'
  )
})

test('a site change is never allowed to end the call', async (t) => {
  // Invariant #20 again, at the one seam that did not exist when it was written: the
  // notifier runs inside the store's notify loop on every site change during a live call.
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'notes-invariant' })
  t.after(() => api.disposeChatLiveVoice())

  const stops = []
  api.liveVoice.stopVoice = (o) => { stops.push(o || {}) }
  const closesBefore = socket.closeCalls

  siteState.setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })
  siteState.setContactOpen(true, { origin: 'visitor' })
  siteState.setContactOpen(false, { origin: 'visitor' })
  siteState.setProject(null, { origin: 'visitor' })
  await afterTheWindow()

  assert.deepEqual(stops, [], 'no site change may call stopVoice')
  assert.equal(socket.closeCalls, closesBefore, 'and none may close the socket by another route')
  assert.equal(api.liveVoice.isSessionOpen(), true)
})
