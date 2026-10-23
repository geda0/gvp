import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  getSiteStateForWire,
  setSection,
  setProject,
  __resetSiteStateForTests
} from '../js/site-state.js'

// Can the browser send a `siteState` the server will REFUSE?
//
// Found by the M2 critic pass, and it is the one defect in this milestone whose blast
// radius is the whole chat.
//
// The two sides have different jobs and were never checked against each other:
//   js/site-state.js   bounds LENGTH   (32 / 64 / 120)
//   site_state.py      rejects on CHARSET  (^[a-z][a-z0-9-]{0,31}$, ^[A-Za-z0-9._-]{1,64}$)
// and a rejection is a 400 for the WHOLE request, on both /api/chat and /api/live/session
// (§6.2 chose reject-not-clamp for identities, deliberately and correctly).
//
// So: one new row in data/projects.json with `"id": "team tactics"` or `"id": "five/d"`,
// and every chat request 400s for as long as that project's dialog is open — text and
// voice both dead, with 364 app tests and 212 chat tests green on both sides, because each
// side is individually correct. The content author never touched any code.
//
// Two rows, because there are two ways to close it and both are needed: the PRODUCER must
// be incapable of emitting a value the validator refuses, and the DATA must not contain one
// in the first place. The second is the one that fails first and reads clearly to whoever
// edits the JSON.
//
// The patterns are read OUT of the Python, not copied — the same cross-language move
// test/nav-target-resolver.test.mjs makes for the tool enums, and for the same reason: a
// copy agrees with the original exactly until someone changes one of them.

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')

function serverPattern (name) {
  const src = read('docker', 'chat', 'app', 'site_state.py')
  const m = new RegExp(`_${name}_PATTERN\\s*=\\s*r?'([^']+)'`).exec(src)
  assert.ok(m, `site_state.py no longer declares _${name}_PATTERN — update this test`)
  return new RegExp(m[1])
}

test.beforeEach(() => __resetSiteStateForTests())

test('every project id in the shipped data is one the server will accept', () => {
  const data = JSON.parse(read('data', 'projects.json'))
  const idPattern = serverPattern('PROJECT_ID')

  const ids = Object.values(data)
    .filter(Array.isArray)
    .flat()
    .map((p) => p && p.id)
    .filter((id) => id !== undefined)

  assert.ok(ids.length > 0, 'harness: no project ids were found, so this proves nothing')

  const rejected = ids.filter((id) => typeof id !== 'string' || !idPattern.test(id))
  assert.deepEqual(
    rejected, [],
    `these project ids would be REFUSED by docker/chat/app/site_state.py: ` +
    `${JSON.stringify(rejected)}. While such a project's dialog is open the browser sends ` +
    'that id in siteState, the server 400s the whole request, and the chat is down — text ' +
    'and voice — for every visitor who opens that card. Ids are identities, so the server ' +
    'rejects rather than clamps (§6.2) and it is right to; the fix belongs in the data. ' +
    `The pattern is ${idPattern}`
  )
})

test('the producer cannot emit a section the server would refuse', () => {
  const sectionPattern = serverPattern('SECTION')
  // §6.2 deliberately lets an UNKNOWN section through — the frontend and the chat host
  // deploy independently, so refusing one would turn an IA rename into a chat outage. That
  // tolerance is about the VALUE, not the shape: a section that is not even the right shape
  // is a bug on this side, and shipping it 400s the request it was meant to survive.
  // `''` is not in this list: the STORE already refuses an empty section outright
  // (setSection throws), which is a stronger guarantee than dropping it at the wire. These
  // are the values that get all the way in and would then be sent.
  for (const bad of ['Portfolio', 'two words', '1home', '../etc', 'x'.repeat(40)]) {
    setSection(bad, { origin: 'visitor' })
    const wire = getSiteStateForWire()
    assert.ok(
      wire.section === null || sectionPattern.test(wire.section),
      `the wire carried section ${JSON.stringify(wire.section)}, which the server refuses ` +
      `(${sectionPattern}). Drop it rather than send it: a missing field costs the model ` +
      'one fact, a 400 costs the visitor the whole conversation'
    )
  }
})

test('the producer cannot emit a project id the server would refuse', () => {
  const idPattern = serverPattern('PROJECT_ID')
  for (const bad of ['team tactics', 'five/d', 'a b', 'p'.repeat(80), 'x\ny']) {
    setProject({ id: bad, title: 'Something' }, { origin: 'visitor' })
    const wire = getSiteStateForWire()
    assert.ok(
      wire.projectId === null || idPattern.test(wire.projectId),
      `the wire carried projectId ${JSON.stringify(wire.projectId)}, which the server ` +
      `refuses (${idPattern})`
    )
    assert.equal(
      wire.projectTitle, 'Something',
      'and dropping the id must not take the rest of the state with it — the section, the ' +
      'form and the title are all still true'
    )
  }
})
