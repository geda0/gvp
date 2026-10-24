// A project chip tapped DURING a live voice call goes to the call (staging voice pass,
// 2026-10-23). MEASURED on stage with the real Live API (scripts/qa/voice-stage-probe.mjs):
// the chip's canned prompt went down the TEXT path - a user bubble appeared and /api/chat was
// asked - while the voice model never received it and talked about the card from the site
// note instead. A visitor in voice tapped "Summarize" and got a different answer, in a
// different modality.
import test from 'node:test'
import assert from 'node:assert/strict'

import { settle, bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'

const tapChip = (docEvents, chip) => docEvents.fire('click', {
  target: { closest: (sel) => (sel.includes('[data-project-chip]') ? { dataset: { projectChip: chip } } : null) }
})

async function bootWithProject(tag, { voice }) {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const h = await bootChatWithLiveVoice({ tag, voice })
  siteState.setProject({ id: 'apptio', title: 'Apptio (an IBM company)' }, { origin: 'visitor' })
  await settle()
  return { ...h, siteState }
}

const chatPosts = (fetchCalls) => fetchCalls.filter((c) => c.url.includes('/api/chat'))

test('during a live call, a chip puts its prompt to the voice model, not the text endpoint', async (t) => {
  const { api, socket, docEvents, fetchCalls } = await bootWithProject('chip-voice', { voice: true })
  t.after(() => api.disposeChatLiveVoice())
  const sentBefore = socket.sent.length
  const postsBefore = chatPosts(fetchCalls).length

  tapChip(docEvents, 'summarize')
  for (let i = 0; i < 4; i++) await settle()

  const turns = socket.sent.slice(sentBefore).map((p) => JSON.parse(p)).filter((m) => m.clientContent)
  const text = turns.flatMap((m) => m.clientContent.turns).flatMap((tu) => tu.parts).map((p) => p.text).join(' ')
  assert.match(text, /Summarize Apptio/, 'the voice model must receive the chip prompt')
  assert.equal(chatPosts(fetchCalls).length, postsBefore, 'and the text endpoint must not be asked as well')
})

test('with no live call, a chip still asks the text chat', async (t) => {
  const { api, docEvents, fetchCalls } = await bootWithProject('chip-text', { voice: false })
  t.after(() => api.disposeChatLiveVoice())
  tapChip(docEvents, 'summarize')
  for (let i = 0; i < 4; i++) await settle()
  assert.ok(chatPosts(fetchCalls).length > 0, 'the text path is the fallback')
})
