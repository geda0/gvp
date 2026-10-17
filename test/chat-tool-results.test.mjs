import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEl, settle, bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'

// Does the assistant's own tool result tell the truth about what happened?
//
// ADR-0015 §9 pinned FIVE mechanical causes behind "the assistant confirmed an action it
// never executed". Cause (a) — the teardown — is fixed and pinned by
// test/site-events-never-stop-voice.test.mjs. This file is the remaining four, each a
// separate row, because the plan merged two of them and missed two entirely:
//
//   (b) §9.3 c1 — the `open_contact_form` toolResponse was DROPPED. openContactFromChat
//       called closePanel SYNCHRONOUSLY, closePanel reached stopVoice, stopVoice set
//       chat-live's `ws = null`, and by the time control returned to the send-guard the
//       socket was gone. Per the Live protocol the model was then waiting forever on a
//       function response, on a socket already closing.
//   (c) §9.2 — on the TEXT path the return value was DISCARDED
//       (`navigateToSection(actionEl.dataset.section || '')`, result unused). A bad section
//       was a silent no-op with no feedback to anyone. The voice path at least round-tripped
//       an error, so the two paths failed differently and the text path failed worse.
//   (d) §9.2 — the match was BYTE-EXACT. Closed by resolveNavTarget
//       (test/nav-target-resolver.test.mjs); this file is the WIRING of it into the tool.
//   (e) §9.4/§5.1 — the NO-OP HASH WRITE. Assigning the fragment the page already has
//       dispatches no `hashchange` per the HTML spec, so js/navigation.js's navigateByHash
//       never ran — yet the tool returned `{ result: 'navigated' }` unconditionally. Benign
//       while the visitor is already there, and a lie under a self-verification contract.
//       False is worse than missing.
//
// WHY THE REAL LIVE PROTOCOL AND NOT A DIRECT CALL. applyVoiceToolCall is a closure inside
// initChat() and is not exported; reaching it any other way would mean exporting it FOR the
// test. Driving `{ toolCall: { functionCalls: [...] } }` over the fake socket and reading
// what comes back in `socket.sent` exercises the exact path the model does, including the
// send-guard at js/chat-live.js:997 that cause (b) is entirely about. A direct call would
// have been green against the dropped response.

const sent = (socket) => socket.sent.map((p) => JSON.parse(p))

const toolResponses = (socket) => sent(socket)
  .flatMap((m) => m?.toolResponse?.functionResponses || [])

async function callTool(socket, name, args, id = 'call-1') {
  socket.onmessage({
    data: JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } })
  })
  await settle()
}

test('navigate_to_section resolves what the model SAID, not the bytes it typed', async (t) => {
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'toolres-nav' })
  t.after(() => api.disposeChatLiveVoice())

  // "Portfolio" is what a model writes for a page the site calls Portfolio. Against the
  // byte-exact chain this was `unknown_section` — a navigation that silently did not happen.
  await callTool(socket, 'navigate_to_section', { section: 'Portfolio' })

  const [response] = toolResponses(socket)
  assert.ok(response, 'the model must receive a toolResponse at all')
  assert.equal(response.name, 'navigate_to_section')
  assert.equal(
    response.response.error, undefined,
    'a capitalised section name must not be an error (ADR-0015 §9.2: the shipped match was ' +
    'byte-exact, so "Portfolio" failed while "portfolio" worked)'
  )
  assert.equal(
    response.response.result, 'navigated',
    'the tool must report the navigation it performed'
  )
  assert.equal(
    response.response.section, 'portfolio',
    'the echoed section must be the RESOLVED id, not the raw string. The model needs to ' +
    'learn the vocabulary the site uses, and the id is what siteState.section holds'
  )
})

test('an unresolvable section still round-trips as an error, with what was received', async (t) => {
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'toolres-bad' })
  t.after(() => api.disposeChatLiveVoice())

  // ADR-0010's vocabulary never shipped (§2): `work` is not a section of this site.
  await callTool(socket, 'navigate_to_section', { section: 'work' })

  const [response] = toolResponses(socket)
  assert.ok(response, 'a refusal must still reach the model — silence leaves it waiting')
  assert.match(
    String(response.response.error), /unknown_section/,
    'the model is the only party that can correct itself, so the refusal has to come back'
  )
  assert.match(
    String(response.response.error) + JSON.stringify(response.response), /work/,
    'the refusal must name what was received, or the model cannot tell which word failed'
  )
})

test('a navigation the router never performed is NOT reported as navigated', async (t) => {
  // Cause (e), the fifth cause the plan does not list. Per the HTML spec, assigning the
  // fragment the document already has fires no hashchange, so navigateByHash never runs.
  const { api, socket, winEvents } = await bootChatWithLiveVoice({ tag: 'toolres-noop' })
  t.after(() => api.disposeChatLiveVoice())

  const hashChanges = []
  winEvents.add('hashchange', () => hashChanges.push(window.location.hash))

  // Put the page where the model is about to send it.
  window.location.hash = '#labs'
  await callTool(socket, 'navigate_to_section', { section: 'labs' })

  const [response] = toolResponses(socket)
  assert.ok(response, 'the model must receive a toolResponse')
  assert.equal(
    hashChanges.length, 1,
    'the router must be driven even when the fragment is unchanged. Assigning the same hash ' +
    'dispatches nothing (HTML spec), so js/navigation.js:62 never ran and the section was ' +
    'never applied — while the tool claimed `navigated` unconditionally (ADR-0015 §5.1)'
  )
  assert.equal(
    response.response.result, 'navigated',
    'and once the router HAS run, `navigated` is true rather than merely asserted'
  )
  assert.equal(response.response.section, 'labs')
})

test('open_contact_form gets its toolResponse delivered, on a socket still open', async (t) => {
  // Cause (b). The dropped response is strictly worse than the mid-sentence cut-off that
  // navigate_to_section suffered, and the plan did not distinguish them.
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'toolres-contact' })
  t.after(() => api.disposeChatLiveVoice())

  await callTool(socket, 'open_contact_form', { subject: 'Hiring', message: 'Hello' })

  const responses = toolResponses(socket)
  assert.equal(
    responses.length, 1,
    'the toolResponse must be SENT. openContactFromChat used to call closePanel ' +
    'synchronously, which set chat-live\'s `ws = null` before the send-guard at ' +
    'js/chat-live.js:997 ran, so the model was left waiting on a response that never came ' +
    '(ADR-0015 §9.3 c1)'
  )
  assert.equal(responses[0].response.result, 'opened_contact_form')
  assert.equal(
    socket.readyState, 1,
    'and the socket must still be open: the visitor is being handed a form by an assistant ' +
    'that should still be able to talk them through it (invariant #20)'
  )
  assert.equal(
    api.liveVoice.isSessionOpen(), true,
    'the live session must survive opening the contact form'
  )
})

test('the TEXT path stops discarding the navigation result', async (t) => {
  // Cause (c). `navigateToSection(actionEl.dataset.section || '')` at js/chat.js:1480 threw
  // the return value away, so a visitor tapping an assistant-rendered button for a section
  // that did not resolve got nothing at all, and nobody — not the visitor, not the model,
  // not analytics — learned it had failed.
  const { api, socket, getEl, gtagCalls } = await bootChatWithLiveVoice({ tag: 'toolres-text' })
  t.after(() => api.disposeChatLiveVoice())
  void socket

  const tapNavButton = async (section) => {
    const el = makeEl('button')
    el.dataset.action = 'navigate'
    el.dataset.section = section
    const handlers = getEl('chatDialog').events.fire('click', {
      target: { closest: (sel) => (sel === '[data-action]' ? el : null) }
    })
    assert.ok(handlers > 0, 'harness: the dialog click handler must be bound, or this is blind')
    await settle()
  }

  window.location.hash = ''
  await tapNavButton('Portfolio')
  assert.equal(
    window.location.hash, '#portfolio',
    'the text path must resolve through the same registry as the voice path. Two paths that ' +
    'disagree about what "Portfolio" means is the drift ADR-0015 §2.1 exists to end'
  )

  gtagCalls.length = 0
  await tapNavButton('somewhere-that-does-not-exist')
  const names = gtagCalls.filter((c) => c[0] === 'event').map((c) => c[1])
  assert.ok(
    names.includes('chat_nav_unresolved'),
    'a navigation the site cannot perform must leave a trace. It need not interrupt the ' +
    'visitor — but "silent no-op with no feedback to anyone" (§9.2) is the defect, and an ' +
    `event is the cheapest honest fix. Saw: ${JSON.stringify(names)}`
  )
})
