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

test('every stop but the last names the next stop; the last names none', () => {
  for (let i = 0; i < TOUR_LENGTH - 1; i++) {
    assert.equal(tourStep(i).next, i + 1)
    assert.deepEqual(tourStep(i).actions, [], 'Next stop / End tour live in the tour bar, not in the message')
  }
  assert.equal(tourStep(TOUR_LENGTH - 1).next, null)
})

test('the tour ends somewhere, not nowhere: back at the work with a way to get in touch', () => {
  const last = tourStep(TOUR_LENGTH - 1)
  const ids = last.actions.map((a) => a.id)
  assert.ok(ids.includes('open-contact'), 'the last stop offers contact')
  assert.ok(!ids.includes('tour-next'))
  assert.equal(last.moves.find((m) => m.kind === 'navigate').section, 'portfolio')
})

async function bootText(tag, chatBody, { withProjects = false } = {}) {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  const h = await bootChatWithLiveVoice({ tag, voice: false })
  if (withProjects) {
    // The real project registry, as js/app.js fills it, so a card can actually open.
    const projects = await import('../js/projects.js')
    projects.initProjectDetailDialog()
    projects.renderProjects('portfolioProjects', PROJECTS.portfolio, 'portfolio')
    await settle()
  }
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

/** Every node under the transcript, depth-first. */
function walk(el, out = []) {
  for (const c of el.children || []) { out.push(c); walk(c, out) }
  return out
}
const transcriptText = (getEl) => walk(getEl('chatMessages'))
  .map((n) => [n.textContent, n.querySelector && n.querySelector('.chat-msg__text').textContent].join(' ')).join(' | ')
const transcriptButtons = (getEl) => walk(getEl('chatMessages')).filter((n) => n.dataset && n.dataset.action)
const messageCount = (getEl) => (getEl('chatMessages').children || []).length

/** A tap on a control, through the dialog's real delegated click handler. */
const tap = (getEl, action) => getEl('chatDialog').events.fire('click', {
  target: { closest: (sel) => (sel === '[data-action]' ? { dataset: { action } } : null) }
})

async function send(api, text) {
  api.openPanelWithMessage(text, 'composer')
  for (let i = 0; i < 6; i++) await settle()
}

test('a text navigate action MOVES the page, leaves no button behind, and says so', async (t) => {
  const { api, siteState, getEl } = await bootText('guide-nav', {
    reply: '',
    actions: [{ id: 'navigate', section: 'portfolio', label: 'See the Portfolio' }]
  })
  t.after(() => api.disposeChatLiveVoice())
  assert.equal(siteState.getSiteState().section, 'home', 'harness: starts at home')
  await send(api, 'show me your work')
  assert.equal(siteState.getSiteState().section, 'portfolio', 'the page moved; a button to tap is the pre-Track-C behaviour')
  assert.ok(!transcriptButtons(getEl).some((b) => b.dataset.action === 'navigate'), 'an executed move leaves no button')
  const text = transcriptText(getEl)
  assert.ok(!/tap below/i.test(text), `the reply must not point at a button that is not there: ${text}`)
  assert.ok(!/try again/i.test(text), text)
})

test('a card that cannot open stays a button the visitor can tap', async (t) => {
  // No registry: the real state of a page whose projects.json has not loaded yet. MUST run
  // before any row that loads the registry - it is a module singleton, like the store.
  const { api, siteState, getEl } = await bootText('guide-proj-miss', {
    reply: 'Here it is.',
    actions: [{ id: 'open-project', project: 'apptio', label: 'Open the project' }]
  })
  t.after(() => api.disposeChatLiveVoice())
  await send(api, 'tell me about Apptio')
  assert.equal(siteState.getSiteState().project, null)
  assert.ok(transcriptButtons(getEl).some((b) => b.dataset.action === 'open-project'), 'the fallback button survives')
})

test('a text open-project action opens the card (read back), with no leftover button', async (t) => {
  const { api, siteState, getEl } = await bootText('guide-proj', {
    reply: 'Here it is.',
    actions: [{ id: 'open-project', project: 'apptio', label: 'Open the project' }]
  }, { withProjects: true })
  t.after(() => api.disposeChatLiveVoice())
  await send(api, 'tell me about Apptio')
  assert.equal(siteState.getSiteState().project?.id, 'apptio', 'the card is on screen')
  assert.ok(!transcriptButtons(getEl).some((b) => b.dataset.action === 'open-project'))
})

test('"show me around" with no prose still reads as intended, never "try again"', async (t) => {
  const { api, getEl } = await bootText('guide-tour-empty', { reply: '', actions: [{ id: 'start-tour', label: 'Start the tour' }] })
  t.after(() => api.disposeChatLiveVoice())
  await send(api, 'show me around')
  const text = transcriptText(getEl)
  assert.ok(!/try again/i.test(text), text)
  assert.ok(text.includes(tourStep(0).say), 'stop 1 is narrated')
})

test('the tour runs on the page: every stop moves it, the bar drives it, End tour ends it', async (t) => {
  const { api, siteState, getEl } = await bootText('guide-tour', {
    reply: 'Happy to - starting the tour.',
    actions: [{ id: 'start-tour', label: 'Start the tour' }]
  }, { withProjects: true })
  t.after(() => api.disposeChatLiveVoice())
  const bar = getEl('chatTourBar')
  assert.equal(bar.hidden, true, 'harness: no tour, no bar')

  await send(api, 'show me around')
  assert.equal(bar.hidden, false, 'the tour bar appears with the first stop')
  for (let i = 0; i < TOUR_LENGTH; i++) {
    const step = tourStep(i)
    const want = step.moves.find((m) => m.kind === 'navigate').section
    const card = step.moves.find((m) => m.kind === 'open-project')
    assert.equal(siteState.getSiteState().section, want, `stop ${i} moved the page`)
    assert.equal(siteState.getSiteState().project?.id ?? null, card ? card.project : null,
      `stop ${i}: ${card ? 'its card is open' : 'no card left open from the stop before'}`)
    assert.ok(transcriptText(getEl).includes(step.say), `stop ${i} is narrated`)
    if (i < TOUR_LENGTH - 1) {
      tap(getEl, 'tour-next')
      for (let k = 0; k < 3; k++) await settle()
    }
  }
  assert.equal(bar.hidden, true, 'the last stop retires the bar')
  assert.ok(transcriptButtons(getEl).some((b) => b.dataset.action === 'open-contact'), 'and ends with a way to get in touch')

  const before = messageCount(getEl)
  tap(getEl, 'tour-next')
  await settle()
  assert.equal(messageCount(getEl), before, 'a tap after the tour has ended does nothing')
})

test('End tour stops the tour where it is, and a stale Next stop cannot restart it', async (t) => {
  const { api, siteState, getEl } = await bootText('guide-tour-end', {
    reply: 'Starting the tour.',
    actions: [{ id: 'start-tour', label: 'Start the tour' }]
  })
  t.after(() => api.disposeChatLiveVoice())
  await send(api, 'show me around')
  const where = siteState.getSiteState().section
  const before = messageCount(getEl)
  tap(getEl, 'tour-end')
  await settle()
  assert.equal(getEl('chatTourBar').hidden, true)
  assert.equal(messageCount(getEl), before + 1, 'End tour answers with one line')
  tap(getEl, 'tour-next')
  await settle()
  assert.equal(siteState.getSiteState().section, where, 'nothing moves after End tour')
  assert.equal(messageCount(getEl), before + 1)
})

test('moves are labelled by who caused them: the agent first, then the visitor taps', async (t) => {
  const { api, siteState, getEl } = await bootText('guide-origin', {
    reply: 'Starting the tour.',
    actions: [{ id: 'start-tour', label: 'Start the tour' }]
  })
  t.after(() => api.disposeChatLiveVoice())
  const changes = []
  const off = siteState.subscribe((_s, change) => { if (change && change.field === 'section') changes.push(change) })
  t.after(() => off && off())
  await send(api, 'show me around')
  assert.equal(changes.at(-1)?.origin, 'agent', 'the first stop answers the model: agent')
  const labs = [...Array(TOUR_LENGTH).keys()].find((i) => tourStep(i).moves.some((m) => m.section === 'labs'))
  for (let i = 1; i <= labs; i++) { tap(getEl, 'tour-next'); await settle() }
  const toLabs = changes.find((c) => c.to === 'labs')
  assert.equal(toLabs?.origin, 'visitor',
    'a stop the visitor tapped is theirs - and agent-labelled changes never reach a live voice session as a note')
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
