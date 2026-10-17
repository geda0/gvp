import test from 'node:test'
import assert from 'node:assert/strict'

import { settle, bootChatWithLiveVoice, makeEl } from './fixtures/chat-harness.mjs'

// Does the site state actually LEAVE the browser, on both paths?
//
// ADR-0015 §6. `getSiteStateForWire()` and its caps are pinned in
// test/site-state-wire.test.mjs; this file is the other half — that the two requests carry
// it, and carry it correctly.
//
// THE ONE THING THAT WOULD BREAK PRODUCTION IF DONE WRONG, and it is not obvious: `siteState`
// must enter the object PASSED INTO buildChatRequest, never be merged into the body
// afterwards. MEASURED (js/chat-payload-hash.js): CloudFront + OAC in front of a Lambda
// Function URL requires the viewer to send `x-amz-content-sha256` over the request body, and
// Lambda recomputes the hash over the real bytes — a body that does not match the digest is
// a 403 InvalidSignatureException at the edge, i.e. the chat is simply down. Any slice that
// stringifies the payload a second time breaks the front door. So this file asserts over the
// BYTES THAT WENT OUT and over the digest, not over an object someone assembled for a test.
//
// THE ABSENT CASE IS A ROW, not an omission (§6.2): an older frontend against a newer server
// sends no siteState and the server must omit the line entirely rather than default it. That
// only works if the key is genuinely absent — `siteState: null` or `{}` is a different claim.

const captureFetch = () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    if (String(url).includes('/api/live/session')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          websocketUrl: 'wss://chat.test/api/live/relay/wire',
          handshake: { setup: {} },
          liveVoiceTransport: 'relay'
        })
      }
    }
    // A minimal SSE reply, so the chat path completes rather than erroring.
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader: () => {
          const chunks = [
            'event: token\ndata: {"delta":"hi"}\n\n',
            'event: done\ndata: {}\n\n'
          ].map((s) => new TextEncoder().encode(s))
          let i = 0
          return {
            read: async () => (i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined }),
            cancel: async () => {}
          }
        }
      },
      text: async () => JSON.stringify({ reply: 'hi' })
    }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

test('the /api/chat body carries siteState, inside the bytes the digest covers', async (t) => {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, getEl } = await bootChatWithLiveVoice({ tag: 'wire-chat', voice: false })
  t.after(() => api.disposeChatLiveVoice())

  siteState.setSection('portfolio', { origin: 'visitor' })
  siteState.setProject({ id: 'team-tactics', title: 'Team Tactics' }, { origin: 'visitor' })

  const { calls, restore } = captureFetch()
  t.after(restore)

  api.openPanelWithMessage('what is this project?')
  await settle(30)

  const chatCall = calls.find((c) => c.url.includes('/api/chat'))
  assert.ok(chatCall, 'harness: no /api/chat request was made, so this proves nothing')

  const sent = JSON.parse(chatCall.opts.body)
  assert.deepEqual(
    sent.siteState, siteState.getSiteStateForWire(),
    'the body must carry the wire snapshot — one conversion, from the module that owns it'
  )
  assert.equal(sent.siteState.section, 'portfolio')
  assert.equal(sent.siteState.projectId, 'team-tactics')

  // The digest has to match the EXACT bytes. If siteState were merged in after
  // buildChatRequest serialized the payload, this is where it shows up — and in production
  // it shows up as a 403 at the CloudFront edge, i.e. the chat is down.
  const header = chatCall.opts.headers?.['x-amz-content-sha256']
  if (header) {
    assert.equal(
      header, await sha256Hex(chatCall.opts.body),
      'x-amz-content-sha256 must cover the bytes that went out. A payload serialized twice ' +
      '(once to hash, once to send) is a 403 InvalidSignatureException at the edge'
    )
  }
  void getEl
})

test('the /api/live/session request carries siteState too', async (t) => {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  siteState.setContactOpen(true, { origin: 'visitor' })

  // The harness's own recorder, not captureFetch: the live-session POST happens DURING boot,
  // so a fetch installed afterwards never sees it and one installed before is overwritten by
  // the harness's own stub. And the section comes from the LOAD URL, not a pre-boot
  // setSection — initNavigation's boot read of the hash overwrites anything written before
  // it, which is the real behaviour and worth exercising rather than working around.
  const { api, fetchCalls } = await bootChatWithLiveVoice({ tag: 'wire-live', hash: '#labs' })
  t.after(() => api.disposeChatLiveVoice())

  const liveCall = fetchCalls.find((c) => c.url.includes('/api/live/session'))
  assert.ok(liveCall, 'harness: no /api/live/session request was made')

  const sent = JSON.parse(liveCall.opts.body)
  assert.ok(sent.sessionId, 'the existing sessionId must survive the addition')
  assert.deepEqual(
    sent.siteState, siteState.getSiteStateForWire(),
    'the voice path needs it MORE than the text path, not less: a voice session is minted ' +
    'once and then talks for minutes, so the greeting is the only chance to tell it where ' +
    'the visitor already is (§6, and §7 keeps it current from there)'
  )
  assert.equal(sent.siteState.section, 'labs')
  assert.equal(sent.siteState.contactOpen, true)
})

test('nothing is sent when there is nothing to say — the key is ABSENT, not null', async (t) => {
  // §6.2: absent means the server omits the "Current site state" line entirely. Not
  // "unknown", not defaulted to home — the model must not be told a fact nobody asserted.
  // That contract only works if the key is genuinely missing; `siteState: null` is a
  // different claim and would have to be handled separately on both sides.
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api } = await bootChatWithLiveVoice({ tag: 'wire-absent', voice: false })
  t.after(() => api.disposeChatLiveVoice())

  const { calls, restore } = captureFetch()
  t.after(restore)

  // Freshly booted on home with nothing open: there is no fact worth a prompt line.
  api.openPanelWithMessage('hello')
  await settle(30)

  const chatCall = calls.find((c) => c.url.includes('/api/chat'))
  assert.ok(chatCall, 'harness: no /api/chat request was made')
  const sent = JSON.parse(chatCall.opts.body)
  assert.equal(
    'siteState' in sent, false,
    'on the default state the key must be ABSENT. Sending `{section:"home", ...all empty}` ' +
    'spends prompt tokens every turn to tell the model the visitor is on the page it would ' +
    'assume anyway'
  )
  void makeEl
})
