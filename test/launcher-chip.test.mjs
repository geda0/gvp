// M4 slice 15 (ADR-0017 §6): the launcher chip and the minimise control ship TOGETHER — a
// minimise button with no visible way back is a trapdoor (the minimised panel is a title and
// a close X). The chip reads chatStage and voiceActive ONLY, and dispatches `restore`, which
// the reducer refuses from `closed` — so a wrongly visible chip can never cold-open a chat.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { nextChatStage } from '../js/chat-stage.js'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const chat = read('js/chat.js')
const html = read('index.html')

test('index.html carries the chip beside the launcher and a minimise control in the chat header', () => {
  const slot = html.slice(html.indexOf('id="agentSlotHero"'), html.indexOf('id="heroChatSuggestions"'))
  assert.match(slot, /id="agentActiveChip"[^>]*hidden/, 'the chip lives in the launcher slot, hidden until a chat exists')
  const header = html.slice(html.indexOf('chat-dialog__header-actions'), html.indexOf('chat-dialog__scroll'))
  assert.match(header, /class="[^"]*chat-dialog__minimize[^"]*"[^>]*aria-label="Minimi[sz]e chat"/)
  assert.ok(header.indexOf('chat-dialog__minimize') < header.indexOf('chat-dialog__close'), 'minimise sits beside, before, the close X')
})

test('the chip renders from chatStage and voiceActive only, and restores', () => {
  const chip = chat.slice(chat.indexOf('const syncActiveChip'), chat.indexOf('const syncActiveChip') + 900)
  assert.ok(chip.length > 50, 'syncActiveChip not found in js/chat.js')
  assert.match(chip, /chatStage/)
  assert.match(chip, /voiceActive/)
  assert.doesNotMatch(chip, /\.section|\.project|contactOpen/, 'a label that changes as the visitor browses is the opposite of "your conversation is still here"')
  assert.match(chat, /agentActiveChip[\s\S]{0,400}dispatchStage\('restore', 'visitor'\)/)
  assert.match(chat, /chat-dialog__minimize[\s\S]{0,400}dispatchStage\('minimize', 'visitor'\)/)
})

test('restore from closed stays closed — the property that makes the chip safe', () => {
  assert.equal(nextChatStage('closed', 'restore', { wide: true }), 'closed')
  // ADR-0027 §2.4: on wide the chip restores the main docked card; narrow still restores modal.
  assert.equal(nextChatStage('minimized', 'restore', { wide: true }), 'docked')
  assert.equal(nextChatStage('minimized', 'restore', { wide: false }), 'modal')
})

test('the launcher click reads chatStage, not isOpen() (true while minimised, so the click did nothing)', () => {
  const handler = chat.slice(chat.indexOf("agentInput.addEventListener('click'"), chat.indexOf("agentInput.addEventListener('click'") + 500)
  assert.doesNotMatch(handler, /isOpen\(\)/)
  assert.match(handler, /chatStage === 'closed'/)
  assert.match(handler, /dispatchStage\('restore', 'visitor'\)/)
})

test('the minimise control is visible only on the docked card', () => {
  const css = read('css/chat.css')
  assert.match(css, /\.chat-dialog__minimize\s*\{[^}]*display:\s*none/)
  assert.match(css, /\[data-chat-stage="docked"\][^{]*\.chat-dialog__minimize\s*\{[^}]*display:\s*inline-flex/)
})
