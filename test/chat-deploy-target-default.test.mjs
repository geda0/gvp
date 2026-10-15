import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const script = readFileSync(join(REPO, 'scripts/integrate-and-deploy.sh'), 'utf8')

// `CHAT_DEPLOY_TARGET` defaulted to `express`, and that default is a footgun that keeps
// resurrecting infrastructure the project deliberately retired.
//
// ECS Express was the chat host until ADR-0022 moved both environments to CloudFront + a
// response-streaming Lambda. The Express services were recorded as deleted on 2026-10-13 —
// and MEASURED STILL RUNNING on 2026-10-15: two ACTIVE services, three running tasks, an
// ECS-managed ALB, and a flat ~$1.13/day across the supposed deletion (~$41/mo that was
// reported as recovered and never was). Each running task also carried the leaked Gemini key
// in its container environment.
//
// The mechanism is this default. Any deploy that forgets the flag takes the `express` arm,
// re-creates the stacks, and `MinTaskCount` scales the service back to 1 — which memory
// already records as having silently undone an earlier scale-to-zero. A retired host that
// rebuilds itself whenever someone omits an environment variable is not retired.
//
// So the default becomes `stream`, the host that actually serves both environments. `express`
// stays reachable EXPLICITLY, because the arm is still the documented rollback path and
// deleting it is a separate decision — but you now have to ask for it by name.
//
// Pinned as a test rather than fixed-and-forgotten because the default is one word in a
// parameter expansion: easy to flip back while tidying, and the consequence (resurrected
// infrastructure, restarted billing) shows up days later in a bill rather than in a diff.

test('CHAT_DEPLOY_TARGET defaults to stream, not the retired express host', () => {
  const m = script.match(/CHAT_DEPLOY_TARGET:-([a-z]+)/)
  assert.ok(m, 'could not find the CHAT_DEPLOY_TARGET default expansion in the deploy script')
  assert.equal(
    m[1], 'stream',
    `the deploy script defaults CHAT_DEPLOY_TARGET to '${m[1]}'. With 'express' any deploy ` +
    'that omits the flag re-creates the retired ECS Express stacks and MinTaskCount scales ' +
    'them back to 1 — measured on 2026-10-15 as two live services, three running tasks, an ' +
    'ECS-managed ALB and ~$41/mo that had been reported as saved.'
  )
})

test('express is still reachable explicitly, so the rollback path survives', () => {
  // The accepted-values guard is a case statement: `express|stream) ;;`. Matching the
  // literal arm rather than a prose string, so renaming the help text cannot make this
  // pass while the value has actually stopped being accepted.
  assert.match(
    script, /express\|stream\)/,
    'the case statement must still accept `express` — it is the documented rollback host, ' +
    'and removing the arm is a separate decision from changing which target you get by ' +
    'default'
  )
  assert.match(
    script, /accepted: express, stream/,
    'the unrecognised-value error must still list express as accepted, or an operator ' +
    'reaching for the rollback is told it does not exist'
  )
})
