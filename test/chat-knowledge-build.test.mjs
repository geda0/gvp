import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// AC-5 (S2 + S3, ADR-0012): prove the chat-knowledge build is idempotent on the
// committed state using the builder's OWN exported code, in-process — NO shell-out,
// NO in-tree write, NO re-derived logic. This file is GENUINELY RED today because
// scripts/build-chat-knowledge.mjs exports NOTHING and runs main() (writes four files)
// as a top-level side effect on import. The red names the spec: the builder must export
// its pure builders and gate the main() CLI side effect so the module imports purely.
import { FAQ, buildProjects, buildRoles } from '../scripts/build-chat-knowledge.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function readJson (...parts) {
  return JSON.parse(readFileSync(join(REPO, ...parts), 'utf8'))
}

function committed (name) {
  return readFileSync(join(REPO, 'data', 'chat-knowledge', name), 'utf8')
}

// The serializer the build uses to write each artifact (ADR-0012 §AC-5).
function serialize (value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

test('rebuilding faq.json from the FAQ source equals the committed artifact (idempotent)', () => {
  assert.equal(serialize(FAQ), committed('faq.json'))
})

test('rebuilding projects.json from data/projects.json equals the committed artifact (idempotent)', () => {
  const projects = readJson('data', 'projects.json')
  assert.equal(serialize(buildProjects(projects)), committed('projects.json'))
})

test('rebuilding roles.json from resume.json equals the committed artifact (idempotent)', () => {
  const resume = readJson('resume', 'resume.json')
  assert.equal(serialize(buildRoles(resume)), committed('roles.json'))
})

test('rebuilding bio.json from bio.source.json equals the committed artifact (idempotent passthrough)', () => {
  // bio.json is a passthrough of bio.source.json — closes the 4th artifact so a
  // hand-edit to either side (or a no-op CLI letting them drift) is caught.
  const bioSource = readJson('data', 'chat-knowledge', 'bio.source.json')
  assert.equal(serialize(bioSource), committed('bio.json'))
})

test('resume-access FAQ entry triggers navigate_to_section, never open_resume', () => {
  const entry = FAQ.find((item) => item.id === 'resume-access')
  assert.ok(entry, 'FAQ must include a resume-access entry')
  assert.equal(
    entry.trigger_tool,
    'navigate_to_section',
    'resume-access must navigate to the on-site section, not open the résumé PDF'
  )
})
