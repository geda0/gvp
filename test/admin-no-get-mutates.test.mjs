// M8 item 6 (ADR-0021): ADMIN_READONLY_KEY is only read-only because NO GET route in
// contact-admin.js mutates. That held when it was reviewed; this fence keeps it holding when a
// future route is added by someone not thinking about the read-only key. It finds every
// function that issues a DynamoDB write (or calls one that does), then requires each call site
// inside the handler to sit under a `method === 'POST'` branch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../aws/src/contact-admin.js', import.meta.url), 'utf8')
const WRITE = /new (UpdateCommand|PutCommand|DeleteCommand|BatchWriteCommand|TransactWriteCommand)\b|SendMessageCommand/

// Top-level function bodies, by name.
function functions(text) {
  const out = new Map()
  const re = /^(?:export )?(?:async )?function (\w+)\s*\(/gm
  const starts = [...text.matchAll(re)].map((m) => [m[1], m.index])
  starts.forEach(([name, at], i) => out.set(name, text.slice(at, i + 1 < starts.length ? starts[i + 1][1] : text.indexOf('export const handler'))))
  return out
}

function writers(fns) {
  const found = new Set([...fns].filter(([, body]) => WRITE.test(body)).map(([n]) => n))
  let grew = true
  while (grew) {
    grew = false
    for (const [name, body] of fns) {
      if (found.has(name)) continue
      if ([...found].some((w) => new RegExp(`\\b${w}\\(`).test(body))) { found.add(name); grew = true }
    }
  }
  return found
}

test('every DynamoDB/SQS writer is reached from the handler only under a POST branch', () => {
  const fns = functions(src)
  const mutators = writers(fns)
  assert.ok(mutators.size >= 4, `expected the four known writers, found ${[...mutators]}`)

  const handler = src.slice(src.indexOf('export const handler')).split('\n')
  const bad = []
  handler.forEach((line, i) => {
    const hit = [...mutators].find((m) => new RegExp(`\\b${m}\\(`).test(line))
    if (!hit) return
    // Nearest enclosing `if (method === …)` at a shallower or equal indent, walking up.
    const indent = line.search(/\S/)
    let guard = null
    for (let j = i; j >= 0; j--) {
      const m = handler[j].match(/^(\s*)if \(method === '(\w+)'/)
      if (m && m[1].length <= indent) { guard = m[2]; break }
    }
    if (guard !== 'POST') bad.push(`handler line ${i + 1}: ${hit}() under ${guard ? `method === '${guard}'` : 'no method guard'}`)
  })
  assert.deepEqual(bad, [], `a read-only admin key could mutate through:\n${bad.join('\n')}`)
})
