import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isContactProjectLink } from '../js/project-link.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function teamTacticsEntry () {
  const data = JSON.parse(readFileSync(join(REPO, 'data', 'projects.json'), 'utf8'))
  return (data.playground || []).find((p) => p.id === 'team-tactics')
}

test('team-tactics is featured in playground with a representable card', () => {
  const data = JSON.parse(readFileSync(join(REPO, 'data', 'projects.json'), 'utf8'))
  const entry = teamTacticsEntry()
  assert.ok(entry, 'playground must include team-tactics')
  assert.equal(entry.hidden, false)
  assert.equal(entry.image, 'team-tactics.svg')
  assert.ok(entry.cardDescription?.length >= 40, 'card needs a substantive blurb')
  assert.ok(entry.description?.includes('Team Tactics'))
  assert.equal(entry.featured, true, 'team-tactics is the featured Labs card')
  assert.equal((data.playground || [])[0]?.id, 'team-tactics', 'team-tactics leads the Labs grid')
})

test('team-tactics CTA opens contact form instead of public GitHub', () => {
  const entry = teamTacticsEntry()
  assert.equal(entry.link, '#contact', 'private repo — link must be in-site contact')
  assert.equal(entry.linkText, 'Request access')
  assert.doesNotMatch(
    entry.link || '',
    /github\.com\/geda0\/team-tactics/,
    'must not link to the private GitHub repo'
  )
  assert.ok(entry.contactPrefill && typeof entry.contactPrefill === 'object')
  assert.equal(typeof entry.contactPrefill.subject, 'string')
  assert.ok(entry.contactPrefill.subject.length > 0)
  assert.equal(typeof entry.contactPrefill.message, 'string')
  assert.ok(entry.contactPrefill.message.length > 0)
})

test('team-tactics chatSummary stays curated for chat retrieval', () => {
  const entry = teamTacticsEntry()
  assert.equal(typeof entry.chatSummary, 'string')
  assert.ok(entry.chatSummary.length >= 200, 'chatSummary should be a concise paragraph, not a stub')
  assert.doesNotMatch(
    entry.chatSummary,
    /^Red = tests only\. Green = source only\. Can't finish on red\./,
    'chatSummary must not duplicate the card blurb — use chatSummary for chat, cardDescription for the card'
  )

  const chat = JSON.parse(readFileSync(join(REPO, 'data', 'chat-knowledge', 'projects.json'), 'utf8'))
  const chatEntry = chat.find((p) => p.id === 'team-tactics')
  assert.equal(chatEntry.summary, entry.chatSummary)
})

test('isContactProjectLink distinguishes contact CTAs from external links', () => {
  assert.equal(isContactProjectLink('#contact'), true)
  assert.equal(isContactProjectLink('https://github.com/geda0/team-tactics'), false)
  assert.equal(isContactProjectLink(''), false)
})

test('team-tactics.svg is clean UTF-8 and readable at a glance', () => {
  const svg = readFileSync(join(REPO, 'team-tactics.svg'), 'utf8')
  assert.ok(!svg.includes('\uFFFD'), 'svg must not contain replacement characters')
  assert.match(svg, /<title[^>]*>Team Tactics/i)
  assert.match(svg, /Team Tactics/)
  assert.match(svg, /TIC BUS|Orchestrator|test-writer/)
  assert.doesNotMatch(svg, /\? test-writer|\? RED test/)
})
