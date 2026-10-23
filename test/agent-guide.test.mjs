// Work-showcase Track C (backlog items 5 and 6): the text agent MOVES the page, and "show me
// around" runs a tour.
//
// THE HOLE THIS FILE IS SHAPED AROUND (peer critic finding, 2026-10-23): a pure seam plus a
// unit test both passed while the one line that drew the pixel had no test, and reverting it
// restored the defect with the suite green. The equivalent hole here is a tour planner that is
// unit-tested while the page never moves. So the planner rows are the small half; the rows
// that matter boot the REAL js/chat.js, answer its /api/chat request, and read the site store
// to see whether the visitor's page actually changed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { settle, bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'
import { tourStep, TOUR_LENGTH } from '../js/tour.js'
import { SECTION_IDS } from '../js/section-names.js'

const PROJECTS = JSON.parse(readFileSync(new URL('../data/projects.json', import.meta.url), 'utf8'))
const PROJECT_IDS = Object.values(PROJECTS).flat().map((p) => p.id)

test('the tour is a short ordered sequence, each stop a move plus a line or two', () => {
  assert.ok(TOUR_LENGTH >= 3 && TOUR_LENGTH <= 6, `a tour, not a slideshow: ${TOUR_LENGTH}`)
  for (let i = 0; i < TOUR_LENGTH; i++) {
    const step = tourStep(i)
    assert.equal(step.index, i)
    assert.ok(step.say && step.say.length <= 260, `stop ${i} narrates in a line or two`)
    assert.equal(step.moves[0].kind, 'close-project', 'every stop starts from a clean page')
    for (const m of step.moves) {
      if (m.kind === 'navigate') assert.ok(SECTION_IDS.includes(m.section), m.section)
      if (m.kind === 'open-project') assert.ok(PROJECT_IDS.includes(m.project), m.project)
    }
  }
  assert.equal(tourStep(0).moves.find((m) => m.kind === 'navigate').section, 'portfolio', 'the tour leads with the work')
  assert.equal(tourStep(TOUR_LENGTH), null)
  assert.equal(tourStep(-1), null)
})

test('every stop but the last offers Next stop and End tour, wired to the right step', () => {
  for (let i = 0; i < TOUR_LENGTH - 1; i++) {
    const ids = tourStep(i).actions.map((a) => a.id)
    assert.deepEqual(ids, ['tour-next', 'tour-end'])
    assert.equal(tourStep(i).actions[0].step, i + 1)
  }
})

test('the tour ends somewhere, not nowhere: back at the work with a way to get in touch', () => {
  const last = tourStep(TOUR_LENGTH - 1)
  const ids = last.actions.map((a) => a.id)
  assert.ok(ids.includes('open-contact'), 'the last stop offers contact')
  assert.ok(!ids.includes('tour-next'))
  assert.equal(last.moves.find((m) => m.kind === 'navigate').section, 'portfolio')
})

async function bootText(tag, chatBody) {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const h = await bootChatWithLiveVoice({ tag, voice: false })
  const harnessFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/chat')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(chatBody)
      }
    }
    return harnessFetch(url, opts)
  }
  return { ...h, siteState }
}

const tap = (getEl, dataset) => getEl('chatDialog').events.fire('click', {
  target: { closest: (sel) => (sel === '[data-action]' ? { dataset } : null) }
})

test('a text navigate action MOVES the page, labelled as the agent', async (t) => {
  const { api, siteState } = await bootText('guide-nav', {
    reply: 'Here is the work.',
    actions: [{ id: 'navigate', section: 'portfolio', label: 'See the Portfolio' }]
  })
  t.after(() => api.disposeChatLiveVoice())
  assert.equal(siteState.getSiteState().section, 'home', 'harness: starts at home')

  api.openPanelWithMessage('show me your work', 'composer')
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(
    siteState.getSiteState().section, 'portfolio',
    'the visitor asked to see the work and the page must move - a button they still have to ' +
    'tap is the pre-Track-C behaviour'
  )
})

test('"show me around" runs the tour on the page, and Next stop moves it on', async (t) => {
  const { api, siteState, getEl } = await bootText('guide-tour', {
    reply: 'Happy to - starting the tour.',
    actions: [{ id: 'start-tour', label: 'Start the tour' }]
  })
  t.after(() => api.disposeChatLiveVoice())

  api.openPanelWithMessage('show me around', 'composer')
  for (let i = 0; i < 5; i++) await settle()
  const first = tourStep(0).moves.find((m) => m.kind === 'navigate').section
  assert.equal(siteState.getSiteState().section, first, 'the first stop moved the page')

  const labsStep = [...Array(TOUR_LENGTH).keys()]
    .find((i) => tourStep(i).moves.some((m) => m.kind === 'navigate' && m.section === 'labs'))
  assert.ok(labsStep !== undefined, 'harness: some stop visits labs')
  tap(getEl, { action: 'tour-next', step: String(labsStep) })
  for (let i = 0; i < 3; i++) await settle()
  assert.equal(siteState.getSiteState().section, 'labs', 'Next stop moved the page to that stop')
})

test('voice can start the tour too, and is told the first stop', async (t) => {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const { api, socket } = await bootChatWithLiveVoice({ tag: 'guide-voice-tour' })
  t.after(() => api.disposeChatLiveVoice())
  socket.onmessage({ data: JSON.stringify({ toolCall: { functionCalls: [{ id: 'v1', name: 'start_tour', args: {} }] } }) })
  await settle()
  const response = socket.sent.map((p) => JSON.parse(p))
    .flatMap((m) => m?.toolResponse?.functionResponses || [])
    .find((r) => r.name === 'start_tour')
  assert.ok(response, 'the model must hear back')
  assert.equal(response.response.result, 'tour_started')
  assert.equal(response.response.stop, tourStep(0).say)
  assert.equal(siteState.getSiteState().section, 'portfolio')
})
