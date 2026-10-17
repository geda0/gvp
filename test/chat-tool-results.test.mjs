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
  // fragment the document already has fires no hashchange, so navigateByHash never ran — and
  // the tool reported `navigated` anyway.
  //
  // THIS ROW ASSERTS THE SECTION WAS APPLIED, not that a hashchange fired. Its first version
  // counted hashchange events, which pinned the MECHANISM: the fix moved routing into
  // js/navigation.js's requestNavigation, which calls applySection directly and synthesises
  // no event at all. That is strictly better — the round trip through the URL was what made
  // the no-op invisible in the first place — and a test that failed on it was asserting an
  // implementation detail it had no business owning.
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'toolres-noop' })
  t.after(() => api.disposeChatLiveVoice())
  const siteState = await import('../js/site-state.js')

  // Put the page where the model is about to send it, through the same door.
  await callTool(socket, 'navigate_to_section', { section: 'labs' })
  assert.equal(siteState.getSiteState().section, 'labs', 'harness: the first move must land')
  socket.sent.length = 0

  await callTool(socket, 'navigate_to_section', { section: 'labs' }, 'call-2')

  const [response] = toolResponses(socket)
  assert.ok(response, 'the model must receive a toolResponse')
  assert.equal(
    siteState.getSiteState().section, 'labs',
    'the section must still be applied when the fragment is unchanged — "we are already ' +
    'there" is a true statement about the page, and the store is where §5.1 reads it back from'
  )
  assert.equal(
    response.response.result, 'navigated',
    'and `navigated` must be true rather than merely asserted (ADR-0015 §5.1)'
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

test('the tool result carries the state READ BACK, never the argument spelled twice', async (t) => {
  // ADR-0015 §5.1, and invariant #21. Without the read-back the echo is worth nothing: it
  // would agree with the request by construction, which is exactly the property a
  // self-verification contract must not have. The no-op hash write (§9.4) is the MEASURED
  // case where constructing it from the arguments would have lied outright.
  //
  // DEVIATION FROM THE ADR, recorded rather than quietly taken: §5.1 specifies subscribing
  // and resolving when the store reports the target, with a 250 ms
  // `navigation_did_not_apply` fallback. That wait existed because the old implementation
  // moved the page by assigning window.location.hash and waited for the hashchange to come
  // back round. Routing now lives in js/navigation.js and calls applySection SYNCHRONOUSLY,
  // so by the time requestNavigation returns the store is already settled and there is
  // nothing to wait for. The ERROR CASE is kept — a read-back that disagrees with the target
  // still fails — because that is the part #21 is about; the timer is not.
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'toolres-echo' })
  t.after(() => api.disposeChatLiveVoice())
  const siteState = await import('../js/site-state.js')

  await callTool(socket, 'navigate_to_section', { section: 'Labs' })
  const [nav] = toolResponses(socket)
  assert.deepEqual(
    nav.response.siteState, siteState.getSiteStateForWire(),
    'the echo must be the store\'s own wire snapshot, taken after the change settled'
  )
  assert.equal(
    nav.response.siteState.section, 'labs',
    'and it must carry the RESOLVED id — the model asked for "Labs" and the site calls it ' +
    '`labs`, which is the vocabulary it should learn'
  )

  socket.sent.length = 0
  await callTool(socket, 'open_contact_form', { subject: 'Hi' }, 'call-c')
  const [contact] = toolResponses(socket)
  assert.equal(contact.response.result, 'opened_contact_form')
  assert.equal(
    contact.response.siteState.contactOpen, true,
    'open_contact_form echoes state too, and the read-back is what proves the form actually ' +
    'opened rather than that the handler was merely called'
  )
  assert.equal(
    contact.response.siteState.section, 'labs',
    'the WHOLE state travels, not just the field the tool touched: the model should not have ' +
    'to remember where the visitor was to know where they still are'
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
