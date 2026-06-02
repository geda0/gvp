import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { slugifyProjectId } from '../js/project-import.js'

test('slugifyProjectId: canonical example collapses punctuation and lowercases', () => {
  assert.equal(slugifyProjectId('DDD: A Presentation!'), 'ddd-a-presentation')
})

test('isValidProject: happy-path minimal valid project returns true', async () => {
  const { isValidProject } = await import('../js/project-import.js')
  const obj = {
    id: 'ddd-a-presentation',
    title: 'DDD: A Presentation',
    cardDescription: 'A short card blurb.',
    description: '<p>A longer HTML description.</p>',
    image: 'images/ddd.png',
    imageAlt: 'Slide cover for the DDD presentation',
    link: 'https://example.com/ddd',
    linkText: 'View slides',
    tech: ['DDD', 'Slides'],
    hidden: false,
    role: 'Speaker'
  }
  assert.equal(isValidProject(obj), true)
})

test('isValidProject: tech with non-string element returns false', async () => {
  const { isValidProject } = await import('../js/project-import.js')
  const obj = {
    id: 'ddd-a-presentation',
    title: 'DDD: A Presentation',
    cardDescription: 'A short card blurb.',
    description: '<p>A longer HTML description.</p>',
    image: 'images/ddd.png',
    imageAlt: 'Slide cover for the DDD presentation',
    link: 'https://example.com/ddd',
    linkText: 'View slides',
    tech: ['DDD', 42],
    hidden: false,
    role: 'Speaker'
  }
  assert.equal(isValidProject(obj), false)
})

test('assertValidProject: throws with field name when linkText is missing', async () => {
  const { assertValidProject } = await import('../js/project-import.js')
  const obj = {
    id: 'ddd-a-presentation',
    title: 'DDD: A Presentation',
    cardDescription: 'A short card blurb.',
    description: '<p>A longer HTML description.</p>',
    image: 'images/ddd.png',
    imageAlt: 'Slide cover for the DDD presentation',
    link: 'https://example.com/ddd',
    linkText: 'View slides',
    tech: ['DDD', 'Slides'],
    hidden: false,
    role: 'Speaker'
  }
  delete obj.linkText
  assert.throws(
    () => assertValidProject(obj),
    err => err instanceof Error && err.message.includes('linkText')
  )
})

test('buildPresentationProject: maps every field and produces a valid project', async () => {
  const { buildPresentationProject, isValidProject } = await import('../js/project-import.js')
  const input = {
    title: 'DDD: A Presentation',
    summary: 'A short blurb.',
    descriptionHtml: '<p>Long HTML description.</p>',
    deckUrl: 'https://example.com/ddd',
    tech: ['DDD', 'Slides'],
    image: 'images/ddd.png',
    imageAlt: 'Slide cover for DDD',
    role: 'Speaker'
  }
  const expected = {
    id: 'ddd-a-presentation',
    title: 'DDD: A Presentation',
    cardDescription: 'A short blurb.',
    description: '<p>Long HTML description.</p>',
    image: 'images/ddd.png',
    imageAlt: 'Slide cover for DDD',
    link: 'https://example.com/ddd',
    linkText: 'View presentation',
    label: 'Presentation',
    kind: 'presentation',
    tech: ['DDD', 'Slides'],
    hidden: false,
    role: 'Speaker'
  }
  const result = buildPresentationProject(input)
  assert.deepEqual(result, expected)
  assert.equal(isValidProject(result), true)
})

test('buildPresentationProject: fills sensible defaults when image/imageAlt/role omitted', async () => {
  const { buildPresentationProject, isValidProject } = await import('../js/project-import.js')
  const input = {
    title: 'DDD: A Presentation',
    summary: 'A short blurb.',
    descriptionHtml: '<p>Long HTML description.</p>',
    deckUrl: 'https://example.com/ddd',
    tech: ['DDD', 'Slides']
  }
  const result = buildPresentationProject(input)
  assert.equal(typeof result.image, 'string')
  assert.ok(result.image.length > 0, 'image should be a non-empty string')
  assert.equal(typeof result.imageAlt, 'string')
  assert.ok(result.imageAlt.length > 0, 'imageAlt should be a non-empty string')
  assert.equal(typeof result.role, 'string')
  assert.ok(result.role.length > 0, 'role should be a non-empty string')
  assert.equal(isValidProject(result), true)
})

test('addProjectToSection: returns new collection with project appended; original not mutated', async () => {
  const { addProjectToSection, buildPresentationProject } = await import('../js/project-import.js')
  const original = {
    playground: [{ id: 'a' }],
    portfolio: [{ id: 'b' }]
  }
  const project = buildPresentationProject({
    title: 'New Talk',
    summary: 's',
    descriptionHtml: '<p>x</p>',
    deckUrl: 'https://e.com/x',
    tech: ['x']
  })
  const next = addProjectToSection(original, 'playground', project)
  assert.notEqual(next, original)
  assert.equal(next.playground.length, original.playground.length + 1)
  assert.equal(next.playground[next.playground.length - 1].id, project.id)
  assert.equal(next.playground[0].id, 'a')
  assert.deepEqual(next.portfolio, original.portfolio)
  assert.equal(original.playground.length, 1)
})

test('addProjectToSection: throws on unknown section, duplicate id, or invalid project', async () => {
  const { addProjectToSection, buildPresentationProject } = await import('../js/project-import.js')
  const validProject = buildPresentationProject({
    title: 'Valid Talk',
    summary: 's',
    descriptionHtml: '<p>x</p>',
    deckUrl: 'https://e.com/x',
    tech: ['x']
  })
  const collection = { playground: [validProject], portfolio: [] }
  const dupeProject = buildPresentationProject({
    title: 'Valid Talk',
    summary: 'different summary',
    descriptionHtml: '<p>y</p>',
    deckUrl: 'https://e.com/y',
    tech: ['y']
  })
  const invalidProject = { ...validProject }
  delete invalidProject.tech
  assert.throws(
    () => addProjectToSection(collection, 'random-section', validProject),
    err => err instanceof Error
  )
  assert.throws(
    () => addProjectToSection(collection, 'playground', dupeProject),
    err => err instanceof Error
  )
  assert.throws(
    () => addProjectToSection(collection, 'playground', invalidProject),
    err => err instanceof Error
  )
})

test('round-trip: building and inserting into real projects.json keeps every entry valid with unique ids', async () => {
  const { buildPresentationProject, addProjectToSection, isValidProject } = await import('../js/project-import.js')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const dataPath = path.resolve(here, '..', 'data', 'projects.json')
  const parsed = JSON.parse(readFileSync(dataPath, 'utf8'))
  const project = buildPresentationProject({
    title: 'Round Trip Talk',
    summary: 's',
    descriptionHtml: '<p>x</p>',
    deckUrl: 'https://e.com/round-trip',
    tech: ['x']
  })
  const next = addProjectToSection(parsed, 'playground', project)
  for (const section of ['playground', 'portfolio']) {
    for (const p of next[section]) {
      assert.equal(isValidProject(p), true, `invalid entry in ${section}: ${p.id}`)
    }
  }
  const ids = [...next.playground, ...next.portfolio].map(p => p.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate id present')
})
