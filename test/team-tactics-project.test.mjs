import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isContactProjectLink } from '../js/project-link.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function teamTacticsEntry () {
  const data = JSON.parse(readFileSync(join(REPO, 'data', 'projects.json'), 'utf8'))
  return (data.playground || []).find((p) => p.id === 'team-tactics')
}

function claimsFixture () {
  return JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'team-tactics-claims.json'), 'utf8'))
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
  assert.notEqual(
    entry.chatSummary.trim(),
    (entry.cardDescription || '').trim(),
    'chatSummary must not duplicate the card blurb — use chatSummary for chat, cardDescription for the card'
  )

  const chat = JSON.parse(readFileSync(join(REPO, 'data', 'chat-knowledge', 'projects.json'), 'utf8'))
  const chatEntry = chat.find((p) => p.id === 'team-tactics')
  assert.equal(chatEntry.summary, entry.chatSummary)
})

test('team-tactics 0.56 copy surfaces MCP cross-tool coordination without overclaiming', () => {
  const entry = teamTacticsEntry()
  const description = entry.description || ''
  const chatSummary = entry.chatSummary || ''

  assert.match(description, /\bMCP\b/, 'description must mention the MCP capability (0.56)')
  assert.match(
    description,
    /cross-tool|other tools?|Cursor/i,
    'description must mention cross-tool coordination (other tools / Cursor)'
  )

  assert.match(description, /tic_emit|emit/, 'description must name the MCP write path (tic_emit / emit)')
  assert.match(description, /opt-in/i, 'description must make clear the MCP path is opt-in')
  assert.match(
    description,
    /hook-only|hook-signed|unforgeable/i,
    'description must keep signal/block/commit hook-only (unforgeable)'
  )
  assert.doesNotMatch(
    description,
    /(other tools?|cross-tool|cursor)[^.]*\b(signal|block|commit)\b/i,
    'description must NOT claim other-tool agents can emit signal/block/commit'
  )

  assert.match(chatSummary, /tic bus/i, 'chatSummary must reference the tic bus')
  assert.match(chatSummary, /gate/i, 'chatSummary must reference the gate')
  assert.match(chatSummary, /MCP/, 'chatSummary must name the MCP server (0.56)')
  assert.match(
    chatSummary,
    /cross-tool|other tools?|cursor|shared bus/i,
    'chatSummary must name cross-tool / shared-bus coordination'
  )

  const accountabilityText = `${description}\n${chatSummary}`
  assert.match(
    accountabilityText,
    /solo-drift|accountability/i,
    'description or chatSummary must surface the solo-drift / accountability nudge'
  )
  assert.doesNotMatch(
    accountabilityText,
    /(solo-drift|accountability)[^.]*\bblocks?\b/i,
    'the solo-drift / accountability nudge must not claim it blocks (it is advisory)'
  )
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

// --- S1 (AC-3): copy/tags trace to the committed claims fixture ---

test('team-tactics tech tags and copy agree with the committed claims fixture', () => {
  const entry = teamTacticsEntry()
  const fixture = claimsFixture()
  const tech = Array.isArray(entry.tech) ? entry.tech : []
  const copy = `${entry.cardDescription || ''}\n${entry.description || ''}\n${entry.chatSummary || ''}`

  // Every headline tag the fixture pins must be a discrete tech tag on the entry.
  for (const tag of fixture.headlineTechTags) {
    assert.ok(
      tech.includes(tag),
      `tech[] must include the fixture headline tag "${tag}" (claim \u2194 fixture)`
    )
  }

  // The copy must not name an MCP tool the fixture (and therefore the server) does not expose.
  const knownTools = new Set(fixture.mcpToolNames)
  const referencedTools = copy.match(/\b(tic_emit|tics_[a-z]+)\b/g) || []
  for (const named of referencedTools) {
    assert.ok(
      knownTools.has(named),
      `copy names MCP tool "${named}" not in the fixture's 7 tool names \u2014 copy must not claim a tool the server doesn't expose`
    )
  }

  // The no-SDK invariant marker must never appear as a *positive* claim in the copy.
  assert.ok(
    !copy.includes(fixture.noSdkInvariant.forbiddenImportMarker),
    'copy must not reference the SDK import marker \u2014 the kit is zero-dependency / no SDK'
  )
})

test('the live MCP kit file exposes the fixture tool set with no third-party require', (t) => {
  const kitPath = join(REPO, '.claude', 'hooks', 'tics-mcp.cjs')
  if (!existsSync(kitPath)) {
    t.skip('tics-mcp.cjs kit file absent \u2014 tripwire skipped (product copy \u2194 fixture contract still holds)')
    return
  }
  const fixture = claimsFixture()
  const source = readFileSync(kitPath, 'utf8')

  // All 7 fixture tool names appear in the live kit (substring/identifier match \u2014 no line numbers).
  for (const name of fixture.mcpToolNames) {
    assert.ok(
      source.includes(name),
      `kit must expose the claimed MCP tool "${name}" \u2014 copy claims a tool set the server actually has`
    )
  }

  // No SDK / zero-dependency: no third-party MCP SDK import.
  assert.ok(
    !source.includes(fixture.noSdkInvariant.forbiddenImportMarker),
    'kit must not import a third-party MCP SDK (@modelcontextprotocol) \u2014 "no SDK / zero-dependency" claim'
  )

  // Every require() target is a Node builtin or a relative/__dirname sibling path \u2014 never a bare npm package.
  const requireTargets = [...source.matchAll(/require\(\s*([^)]*?)\s*\)/g)].map((m) => m[1].trim())
  const builtins = new Set(['fs', 'path', 'child_process', 'os', 'url', 'crypto', 'util', 'assert', 'stream', 'events'])
  for (const raw of requireTargets) {
    const isSiblingPath = raw.includes('__dirname') || raw.includes('path.join') || /^['"]\.\.?\//.test(raw)
    const literal = raw.replace(/^['"]|['"]$/g, '')
    const isBuiltin = builtins.has(literal) || literal.startsWith('node:')
    assert.ok(
      isSiblingPath || isBuiltin,
      `kit require(${raw}) must be a Node builtin or a sibling kit path \u2014 no third-party dependency (zero-dependency claim)`
    )
  }
})

// --- S4 (AC-1): the card names the engineering, not just the workflow ---

test('team-tactics card names the hand-rolled MCP and the zero-dependency nature', () => {
  const entry = teamTacticsEntry()
  const card = entry.cardDescription || ''

  assert.match(
    card,
    /hand-rolled MCP/i,
    'card must name the hand-rolled MCP server, not only the red/green workflow'
  )
  assert.match(
    card,
    /zero-dependency|zero dependencies|no dependencies/i,
    'card must surface the zero-dependency nature'
  )
})

// --- S5 (AC-2 bullets 1+2): the dialog description surfaces the engineering story ---

test('team-tactics description surfaces JSON-RPC/stdio/no-SDK engineering without overclaiming', () => {
  const entry = teamTacticsEntry()
  const description = entry.description || ''

  assert.match(description, /hand-rolled MCP/i, 'description must name the hand-rolled MCP server')
  assert.match(description, /JSON-RPC 2\.0/i, 'description must specify JSON-RPC 2.0')
  assert.match(description, /stdio/i, 'description must specify the stdio transport')
  assert.match(
    description,
    /no SDK|written from scratch/i,
    'description must make clear it was written from scratch with no SDK'
  )
  assert.match(
    description,
    /zero dependenc|zero-dependency|no dependencies/i,
    'description must surface the zero-dependency kit'
  )
})

// --- S6 (AC-4): chatSummary surfaces the same engineering and stays in sync ---

test('team-tactics chatSummary surfaces the MCP engineering and is not a card duplicate', () => {
  const entry = teamTacticsEntry()
  const chatSummary = entry.chatSummary || ''

  assert.match(chatSummary, /hand-rolled MCP/i, 'chatSummary must name the hand-rolled MCP server')
  assert.notEqual(
    chatSummary.trim(),
    (entry.cardDescription || '').trim(),
    'chatSummary must not be a verbatim duplicate of the card blurb'
  )

  const chat = JSON.parse(readFileSync(join(REPO, 'data', 'chat-knowledge', 'projects.json'), 'utf8'))
  const chatEntry = chat.find((p) => p.id === 'team-tactics')
  assert.equal(
    chatEntry.summary,
    entry.chatSummary,
    'derived chat-knowledge summary must stay in sync with the source chatSummary'
  )
})

// --- S7 (AC-6): presentation-field invariant \u2014 required fields stay non-empty ---

test('team-tactics keeps required presentation fields non-empty so a future edit cannot blank the card', () => {
  const entry = teamTacticsEntry()

  for (const field of ['cardDescription', 'description', 'chatSummary', 'image', 'role']) {
    assert.equal(typeof entry[field], 'string', `${field} must be a string`)
    assert.ok(entry[field].trim().length > 0, `${field} must be a non-empty string`)
  }
  assert.ok(Array.isArray(entry.tech) && entry.tech.length > 0, 'tech[] must be a non-empty array')
})
