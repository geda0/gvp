import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { normalizeSection } from '../js/section-names.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')

test('normalizeSection maps sections to chat/agent buckets incl. new labs', () => {
  // The new top-level "Labs" page introduces its own bucket, and legacy
  // 'playground' bookmarks/state now resolve to it (no longer 'portfolio').
  assert.equal(normalizeSection('labs'), 'labs')
  assert.equal(normalizeSection('playground'), 'labs')
  assert.equal(normalizeSection('portfolio'), 'portfolio')
  assert.equal(normalizeSection('home'), 'home')
  assert.equal(normalizeSection('anything-else'), 'home')
})

test('team-tactics is the first, featured card in the Labs (playground) data', () => {
  const data = JSON.parse(read('data', 'projects.json'))
  const labs = data.playground || []
  assert.equal(labs[0]?.id, 'team-tactics', 'team-tactics must be first (the featured lead)')
  assert.equal(labs[0]?.featured, true, 'team-tactics must carry featured:true')
})

test('index.html exposes the Labs page, nav link, and teaser; playground subsection removed', () => {
  const html = read('index.html')
  // New Labs top-level page + its project grid.
  assert.match(html, /id="labsContent"/)
  assert.match(html, /id="labsProjects"/)
  // Nav link + route.
  assert.match(html, /id="labsNav"/)
  const labsHrefs = (html.match(/href="#labs"/g) || []).length
  assert.ok(labsHrefs >= 2, `expected >=2 href="#labs" (nav + teaser), found ${labsHrefs}`)
  // Portfolio teaser across to Labs.
  assert.match(html, /class="portfolio-labs-teaser"/)
  // Portfolio page stays intact (professional grid still present)...
  assert.match(html, /id="portfolioProjects"/)
  // ...but the old playground subsection is gone from it.
  assert.doesNotMatch(html, /class="playground-intro"/)
  assert.doesNotMatch(html, /<section id="projects"/)
})

test('navigation routes Labs and preserves the legacy #playground redirect', () => {
  const nav = read('js', 'navigation.js')
  assert.match(nav, /#labs/, 'navigation must handle the #labs route')
  assert.match(nav, /#playground/, 'legacy #playground redirect must be preserved')
  assert.match(nav, /#portfolio/, 'portfolio route must remain')
  assert.match(nav, /goLabs/, 'a goLabs page handler must exist')
})
