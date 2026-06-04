import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))

test('team-tactics is featured in playground with a representable card', () => {
  const data = JSON.parse(readFileSync(join(REPO, 'data', 'projects.json'), 'utf8'))
  const entry = (data.playground || []).find((p) => p.id === 'team-tactics')
  assert.ok(entry, 'playground must include team-tactics')
  assert.equal(entry.hidden, false)
  assert.equal(entry.image, 'team-tactics.svg')
  assert.ok(entry.cardDescription?.length >= 40, 'card needs a substantive blurb')
  assert.ok(entry.description?.includes('Team Tactics'))
  assert.equal(entry.link, 'https://github.com/geda0/team-tactics')
})

test('team-tactics.svg is clean UTF-8 and readable at a glance', () => {
  const svg = readFileSync(join(REPO, 'team-tactics.svg'), 'utf8')
  assert.ok(!svg.includes('\uFFFD'), 'svg must not contain replacement characters')
  assert.match(svg, /<title[^>]*>Team Tactics/i)
  assert.match(svg, /Team Tactics/)
  assert.match(svg, /TIC BUS|Orchestrator|test-writer/)
  assert.doesNotMatch(svg, /\? test-writer|\? RED test/)
})
