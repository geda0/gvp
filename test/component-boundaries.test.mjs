// M5 (ADR-0018) — component boundaries for js/ and the SDK-free cores in aws/src, fenced where
// the modules live (an ADDRESS MAP, not a relocation: moving files would only churn paths other
// work is editing; the fence is what makes the layout real).
//   lib        → lib only
//   components → lib, shell and themselves; never another component except a DECLARED seam
//   shell      → lib and shell (app.js, the orchestrator, may import anything)
//   admin      → admin only, and nothing outside admin imports it
// A module missing from the map fails, so a new file is placed before it lands.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const JS = new URL('../js/', import.meta.url)
const read = (name) => readFileSync(new URL(name, JS), 'utf8')

const ADDRESS = {
  lib: ['starfield-prefs', 'precipitation', 'theme-time', 'tour'],
  assistant: ['chat', 'chat-live', 'chat-bus', 'chat-panel-anim', 'chat-payload-hash', 'chat-prewarm', 'chat-reply-text',
    'chat-stage', 'agent-node', 'voice-resume-button', 'voice-turn-gate', 'nav-promise-gap', 'site-state-notes',
    'project-chips', 'selection-offer', 'selection-offer-ui'],
  theme: ['theme', 'starfield', 'time-switcher-mode'],
  hero: ['spaceman', 'spaceman-position', 'spaceman-project-context', 'project-observer'],
  admin: ['admin', 'admin-attention', 'admin-assistant'],
  shell: ['app', 'navigation', 'projects', 'contact', 'site-state', 'analytics', 'site-events', 'site-config',
    'section-names', 'dialog-helpers', 'privacy-note', 'project-link', 'project-ref']
}
const COMPONENTS = new Set(['assistant', 'theme', 'hero', 'admin'])
// Cross-component imports that exist on purpose. Adding one is a design decision: put it here
// with the reason, in the same change.
const SEAMS = new Set([
  'spaceman -> chat-bus', // the spaceman reacts to chat open/close events on the shared bus
  'spaceman -> theme', // the spaceman's copy is theme-aware
  'spaceman-position -> chat-panel-anim' // the spaceman steps aside from the animating chat panel
])

const where = new Map(Object.entries(ADDRESS).flatMap(([c, mods]) => mods.map((m) => [m, c])))
const modules = readdirSync(JS).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))
const importsOf = (m) => [...new Set([...read(`${m}.js`).matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)'\.\/([a-z0-9-]+)\.js'/gm)].map((x) => x[1]))]

test('every js module has an address', () => {
  const unplaced = modules.filter((m) => !where.has(m))
  assert.deepEqual(unplaced, [], `place these in ADDRESS (test/component-boundaries.test.mjs) before they land: ${unplaced}`)
})

test('imports respect the layers, and cross-component imports are declared seams', () => {
  const broken = []
  for (const m of modules) {
    const from = where.get(m)
    if (!from || m === 'app') continue
    for (const dep of importsOf(m)) {
      const to = where.get(dep)
      if (!to || to === from || to === 'lib') continue
      if (from === 'lib') broken.push(`${m} (lib) imports ${dep} (${to})`)
      else if (from === 'admin' || to === 'admin') broken.push(`${m} (${from}) <-> ${dep} (${to}): admin stands alone`)
      else if (from === 'shell' && COMPONENTS.has(to)) broken.push(`${m} (shell) imports ${dep} (${to}) — only app.js wires components`)
      else if (COMPONENTS.has(from) && COMPONENTS.has(to) && !SEAMS.has(`${m} -> ${dep}`)) broken.push(`${m} (${from}) imports ${dep} (${to}) — undeclared seam`)
    }
  }
  assert.deepEqual(broken, [], 'component boundary crossed:\n' + broken.join('\n'))
})

test('every declared seam still exists (a dead seam is a stale permission)', () => {
  for (const seam of SEAMS) {
    const [from, to] = seam.split(' -> ')
    assert.ok(importsOf(from).includes(to), `declared seam no longer used: ${seam}`)
  }
})

test('the SDK-free cores in aws/src never import @aws-sdk', () => {
  // aws/src/admin/ (M4 slice 17) holds admin cores only: everything there is SDK-free.
  const dirs = ['../aws/src/common/', '../aws/src/admin/'].map((d) => new URL(d, import.meta.url))
  const cores = dirs.flatMap((dir) => readdirSync(dir)
    .filter((f) => /-core\.js$/.test(f) || f === 'admin-auth.js' || dir.pathname.endsWith('/admin/'))
    .map((f) => new URL(f, dir)))
  assert.ok(cores.length >= 5, `found ${cores}`)
  const dirty = cores.filter((u) => /@aws-sdk\//.test(readFileSync(u, 'utf8'))).map((u) => u.pathname)
  assert.deepEqual(dirty, [], `cores must stay SDK-free so they test without node_modules: ${dirty}`)
})
