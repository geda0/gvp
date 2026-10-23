import test from 'node:test'
import assert from 'node:assert/strict'

import { bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'

// ITS OWN FILE, and that is the point rather than an accident.
//
// js/contact.js keeps `openContactDialogImpl` at module scope and initContactForm assigns
// it. The harness imports contact.js UNBUSTED on purpose — a cache-busted copy would be a
// second module instance that the (busted) js/chat.js never reaches, the same trap that
// made the navigation wiring look broken earlier in this milestone. So within one test
// file, any earlier boot that ran initContactForm has already armed the impl, and a later
// `contact: false` boot still opens the dialog.
//
// node --test runs each FILE in its own process, so a file that never arms it is the
// cheapest honest way to get the un-initialised state — no test-only reset exported from
// production for the sake of one row.

const toolResponses = (socket) => socket.sent
  .map((p) => JSON.parse(p))
  .flatMap((m) => m?.toolResponse?.functionResponses || [])

async function callTool (socket, name, args, id = 'call-1') {
  socket.onmessage({
    data: JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } })
  })
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
}

test('open_contact_form reports failure when the form did not open', async (t) => {
  // Invariant #21's second half — "a change that did not apply returns an error, not a
  // success" — which had no reachable case anywhere in M2 until this one. The nav path's
  // `navigation_did_not_apply` branch is dead by construction, because routing moved into
  // js/navigation.js and applySection is synchronous.
  //
  // This path is NOT dead. openContactDialogImpl is a no-op until initContactForm has run,
  // and initContactForm returns early when any of seven DOM nodes is missing — so on a page
  // where the contact dialog was renamed or removed, the tool returned
  // `opened_contact_form` and the voice model SAID SO OUT LOUD, while the echoed siteState
  // sitting right beside it said contactOpen: false. The harness's own comment recorded
  // this ("without this the tool runs, reports success, and contactOpen stays false") and
  // the suite worked around it instead of pinning it.
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'toolres-nocontact', contact: false })
  t.after(() => api.disposeChatLiveVoice())

  await callTool(socket, 'open_contact_form', { subject: 'Hiring' })

  const [response] = toolResponses(socket)
  assert.ok(response, 'the model must still receive a response')
  assert.equal(
    siteState.getSiteState().contactOpen, false,
    'harness: the form must genuinely not have opened, or this proves nothing'
  )
  assert.equal(
    response.response.result, undefined,
    'a form that did not open must not be reported as opened. The model repeats this to ' +
    'the visitor; false is worse than missing (#21)'
  )
  assert.match(String(response.response.error), /contact/i)
  assert.equal(
    response.response.siteState.contactOpen, false,
    'and the echo must agree with the verdict rather than contradict it'
  )
})
