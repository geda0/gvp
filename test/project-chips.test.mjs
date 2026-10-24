// M4 slice 13 (ADR-0017 §7.5, §2.5): project chips inside #projectDialog — the only place a tap
// can land while a card is up — are open-beside's caller. They carry NO visitor text: a project
// title from the store and a canned prompt from a fixed table, so they may submit directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROJECT_CHIPS, projectChipPrompt } from '../js/project-chips.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('three chips, fixed ids, each prompt naming the open project', () => {
  assert.deepEqual(PROJECT_CHIPS.map((c) => c.id), ['summarize', 'more', 'talk'])
  for (const { id } of PROJECT_CHIPS) {
    const prompt = projectChipPrompt(id, 'Team Tactics')
    assert.ok(prompt.includes('Team Tactics'), `${id}: ${prompt}`)
  }
})

test('an unknown chip or a missing title yields no prompt (nothing to submit)', () => {
  assert.equal(projectChipPrompt('nope', 'Team Tactics'), '')
  assert.equal(projectChipPrompt('summarize', ''), '')
  assert.equal(projectChipPrompt('constructor', 'X'), '')
})

test('the chips are inside the project dialog panel', () => {
  const html = read('index.html')
  const panel = html.slice(html.indexOf('id="projectDialog"'), html.indexOf('id="contactDialog"'))
  for (const { id } of PROJECT_CHIPS) assert.match(panel, new RegExp(`data-project-chip="${id}"`))
})

// ADR-0029 §2.1 (deliberate test-writer change): the room is besideLayout's reserve, a
// function of the viewport - no live panel measurement any more.
test('js/chat.js wires the chips to open-beside with roomBeside from besideLayout, and sends the canned prompt', () => {
  const chat = read('js/chat.js')
  const block = chat.slice(chat.indexOf('[data-project-chip]'), chat.indexOf('[data-project-chip]') + 2600)
  assert.match(block, /roomBeside = besideLayout\([^)]*\)\.reserve > 0/)
  assert.doesNotMatch(block, /getBoundingClientRect\(\)|hasRoomBesideDialog/)
  assert.match(block, /dispatchStage\('open-beside', 'visitor', \{ roomBeside/)
  assert.match(block, /projectChipPrompt\(/)
  assert.match(block, /sendMessage\(/)
})

test('critic: a project-chip prompt is not also counted as a composer submit', () => {
  const chat = read('js/chat.js')
  const branch = chat.slice(chat.indexOf("if (source === 'hero') {"), chat.indexOf("trackEvent('chat_composer_submit'"))
  assert.match(branch, /source === 'project_chip'/, 'project_chip must be its own branch before the composer default')
})

// Stage-found defect: the text path renders open_project / close_project as action BUTTONS
// (the assistant cannot move the page on text; the tap is the visitor's), so the button must
// carry the project id and the click handler must open / close the card.
test('open-project / close-project action buttons are wired', () => {
  const chat = read('js/chat.js')
  const make = chat.slice(chat.indexOf('const createActionButton'), chat.indexOf('const createActionButton') + 700)
  assert.match(make, /button\.dataset\.project = action\.project/)
  const click = chat.slice(chat.indexOf("const actionEl = event.target.closest('[data-action]')"), chat.indexOf("const actionEl = event.target.closest('[data-action]')") + 2600)
  assert.match(click, /action === 'open-project'[\s\S]{0,300}requestProjectOpen\(actionEl\.dataset\.project/)
  assert.match(click, /action === 'close-project'[\s\S]{0,200}requestProjectClose\(/)
})
