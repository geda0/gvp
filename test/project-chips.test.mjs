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

test('js/chat.js wires the chips to open-beside with a MEASURED roomBeside, and sends the canned prompt', () => {
  const chat = read('js/chat.js')
  const block = chat.slice(chat.indexOf('[data-project-chip]'), chat.indexOf('[data-project-chip]') + 1600)
  assert.match(block, /hasRoomBesideDialog\(/)
  assert.match(block, /getBoundingClientRect\(\)/)
  assert.match(block, /dispatchStage\('open-beside', 'visitor', \{ roomBeside/)
  assert.match(block, /projectChipPrompt\(/)
  assert.match(block, /sendMessage\(/)
})
