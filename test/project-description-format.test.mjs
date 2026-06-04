import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PROJECTS_PATH = join(REPO, 'data', 'projects.json')

/** Named entities should not appear in copy — use UTF-8 punctuation in JSON instead. */
const BANNED_ENTITY_RE = /&(ldquo|rdquo|lsquo|rsquo|nbsp|mdash);/i

function allProjectDescriptions () {
  const data = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'))
  const rows = []
  for (const section of ['playground', 'portfolio']) {
    for (const item of data[section] || []) {
      if (item.description) {
        rows.push({ id: item.id, section, description: item.description })
      }
    }
  }
  return rows
}

test('project descriptions avoid literal HTML entity escapes in source JSON', () => {
  for (const { id, description } of allProjectDescriptions()) {
    assert.ok(
      !BANNED_ENTITY_RE.test(description),
      `${id} description must not contain HTML entities like &ldquo; — use UTF-8 quotes`
    )
    assert.ok(
      !/&amp;/.test(description),
      `${id} description must use literal & in copy, not &amp;`
    )
  }
})

test('project descriptions use paragraph markup for dialog rendering', () => {
  for (const { id, description } of allProjectDescriptions()) {
    assert.match(
      description,
      /<p\b/i,
      `${id} description should use <p> blocks so the dialog is not one blob`
    )
  }
})
