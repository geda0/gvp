// A project chip tapped DURING a live voice call goes to the call (staging voice pass,
// 2026-10-23). MEASURED on stage with the real Live API (scripts/qa/voice-stage-probe.mjs):
// the chip's canned prompt went down the TEXT path - a user bubble appeared and /api/chat was
// asked - while the voice model never received it and talked about the card from the site
// note instead. A visitor in voice tapped "Summarize" and got a different answer, in a
// different modality.
import test from 'node:test'
import assert from 'node:assert/strict'

import { settle, bootChatWithLiveVoice, defineGlobal } from './fixtures/chat-harness.mjs'

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

// Swapped in AFTER boot: the player builds its AudioContext lazily on the first chunk, so
// every source the assistant's audio starts from here on is recorded with its stop flag.
function recordPlayback () {
  const sources = []
  defineGlobal('AudioContext', class RecordingAudioContext {
    constructor () { this.sampleRate = 24000; this.state = 'running'; this.currentTime = 0; this.destination = {} }
    async resume () {}
    async close () {}
    createBuffer (channels, length, rate) { return { duration: length / rate, copyToChannel () {} } }
    createBufferSource () {
      const src = { started: false, stopped: false, connect () {}, start () { src.started = true }, stop () { src.stopped = true } }
      sources.push(src)
      return src
    }
  })
  return { playing: () => sources.filter((s) => s.started && !s.stopped).length }
}
const greetingAudio = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa('\u0000\u0001\u0000\u0002') } }] } } }

test('a chip tapped while the assistant is speaking stops playback locally, before any server frame (G2)', async (t) => {
  // Arrange — a live call, the greeting audio playing.
  const { api, socket, docEvents } = await bootWithProject('chip-cut', { voice: true })
  t.after(() => api.disposeChatLiveVoice())
  const playback = recordPlayback()
  socket.onmessage({ data: JSON.stringify(greetingAudio) })
  await settle()
  const playingBefore = playback.playing()

  // Act — the chip, and nothing from the server.
  tapChip(docEvents, 'summarize')
  for (let i = 0; i < 4; i++) await settle()

  // Assert
  assert.deepEqual(
    { playingBefore, playingAfter: playback.playing() },
    { playingBefore: 1, playingAfter: 0 },
    'invariant #25: the chip that goes to the call must cut the assistant off locally (ADR-0026 §3.1)'
  )
})

test('with no live call, a chip still asks the text chat', async (t) => {
  const { api, docEvents, fetchCalls } = await bootWithProject('chip-text', { voice: false })
  t.after(() => api.disposeChatLiveVoice())
  tapChip(docEvents, 'summarize')
  for (let i = 0; i < 4; i++) await settle()
  assert.ok(chatPosts(fetchCalls).length > 0, 'the text path is the fallback')
})
