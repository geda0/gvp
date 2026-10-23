import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveProjectRef } from '../js/project-ref.js'

// Turning what the model said into a project the site has (ADR-0017 §3.2).
//
// Same leaf-plus-registry shape as js/section-names.js, with ONE deliberate difference: the
// section registry is a hard-coded constant because the site has three sections and they
// are structural, while the project registry is CONTENT loaded at runtime. So it is
// INJECTED, never imported — a pure leaf that reached into js/projects.js's module-level
// Map would not be pure, and this way the resolver is testable with a three-row fixture
// instead of a DOM.
//
// NO FUZZY MATCHING, and that is the same ruling as ADR-0015 §5.2's rejection of
// inferPromisedNavigation, one layer down. A loose match over 13 titles that include "AI
// assistant & chatbot" and "Generative Video Platform" will pick the wrong card for "tell
// me about the video one" — and opening the WRONG project is a worse failure than saying
// you could not find it, because the model can ask a follow-up but cannot un-see a card
// the visitor did not want.

const REGISTRY = [
  { id: 'team-tactics', title: 'Team Tactics' },
  { id: 'gvp', title: 'Generative Video Platform' },
  { id: 'monday-rover', title: 'Monday Rover' }
]

test('an exact id resolves', () => {
  assert.deepEqual(resolveProjectRef('team-tactics', REGISTRY), { id: 'team-tactics', title: 'Team Tactics' })
})

test('case and whitespace stop being failure modes, on ids and titles alike', () => {
  // ADR-0015 §9.2 measured this on sections: the shipped chain compared bytes, so
  // "Portfolio" — the capitalisation a model naturally uses for a proper noun — fell
  // through to unknown_section while "portfolio" worked.
  for (const raw of ['Team-Tactics', ' team-tactics ', 'TEAM-TACTICS', '\tteam-tactics\n']) {
    assert.deepEqual(
      resolveProjectRef(raw, REGISTRY), { id: 'team-tactics', title: 'Team Tactics' },
      `${JSON.stringify(raw)} must resolve`
    )
  }
  for (const raw of ['Team Tactics', 'team tactics', '  Generative Video Platform  ']) {
    const got = resolveProjectRef(raw, REGISTRY)
    assert.ok(got.id, `${JSON.stringify(raw)} must resolve by title; got ${JSON.stringify(got)}`)
  }
})

test('an id beats a title, so an ambiguous registry cannot flip the answer', () => {
  // A registry where one project's TITLE is another's ID. Matching ids first makes the
  // outcome a property of the order rather than of iteration order.
  const tricky = [
    { id: 'rover', title: 'Monday Rover' },
    { id: 'monday-rover', title: 'rover' }
  ]
  assert.equal(resolveProjectRef('rover', tricky).id, 'rover', 'the exact id wins')
})

test('a near miss is REFUSED, not guessed', () => {
  for (const raw of ['the video one', 'tactics', 'Monday', 'team', 'generative']) {
    const got = resolveProjectRef(raw, REGISTRY)
    assert.equal(
      got.error, 'unknown_project',
      `${JSON.stringify(raw)} must NOT resolve. Substring matching picks "Generative Video ` +
      'Platform" for "the video one" only by luck, and opening the wrong card is worse than ' +
      'reporting that you could not find it — the model can ask, the visitor cannot un-see it'
    )
    assert.equal(got.received, raw, 'the refusal must carry back what was said')
    assert.equal(got.id, undefined)
  }
})

test('an inherited property name is not a project', () => {
  // The same hazard js/section-names.js carries a comment about: a bare REGISTRY[key]
  // reaches the prototype chain, so resolve('constructor') returned a FUNCTION — neither a
  // target nor an error — and the caller threw a TypeError out of the tool call.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const got = resolveProjectRef(key, REGISTRY)
    assert.equal(got.error, 'unknown_project', `${key} must be refused; got ${JSON.stringify(got)}`)
  }
})

test('a missing or malformed registry refuses rather than throwing', () => {
  // The registry is populated per card at render time, so before the projects render it is
  // empty. A resolver that threw there would take out the tool call; one that guessed would
  // open a card that does not exist yet.
  for (const registry of [undefined, null, [], 'nope', 42, [null], [{}], [{ id: 1 }]]) {
    const got = resolveProjectRef('team-tactics', registry)
    assert.equal(
      got.error, 'unknown_project',
      `registry ${JSON.stringify(registry)} must refuse, not throw or guess`
    )
  }
})

test('a non-string ref is refused, not coerced', () => {
  for (const raw of [null, undefined, 42, {}, []]) {
    assert.equal(resolveProjectRef(raw, REGISTRY).error, 'unknown_project')
  }
})

test('the resolver cannot reach the DOM or the project store', () => {
  const src = resolveProjectRef.toString()
  for (const forbidden of ['document', 'window', 'projectDetailsById', 'import(']) {
    assert.ok(
      !src.includes(forbidden),
      `resolveProjectRef touches ${forbidden} — the registry is INJECTED precisely so this ` +
      'stays a pure function of its arguments'
    )
  }
})
