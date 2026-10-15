import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const DIR = join(REPO, '.github/workflows')

// CI was rebuilding the retired ECS Express host on every push.
//
// Both deploy workflows hardcoded `CHAT_DEPLOY_TARGET: express`, and they fire on pushes to
// `main` and `agent`. So every push re-created gvp-chat-express-{stage,prod}, and
// MinTaskCount scaled the services back to 1. MEASURED 2026-10-15:
//
//   deploy-staging  in_progress  15:11:40  agent
//   deploy-staging  success      14:57:15  agent
//   deploy-prod     success      14:56:24  main
//
// matching stack events UPDATE_IN_PROGRESS at 14:59 and 15:13 on the stage Express stack —
// which is also why a delete-stack attempt failed with "cannot be deleted while in status
// UPDATE_IN_PROGRESS". The services were never gone for more than minutes, which is why the
// ELB+ECS cost line stayed flat at ~$1.13/day across a deletion that was reported as saving
// ~$41/mo. Each resurrected task also carried the leaked Gemini key in its environment.
//
// Note what this does NOT fix: changing the script's default to `stream` is irrelevant here,
// because the workflows pass the value EXPLICITLY. An env var in CI outranks any default,
// which is exactly why the earlier fix looked sufficient and wasn't.
//
// ADR-0022 moved both environments to CloudFront + a response-streaming Lambda. CI must
// deploy the host that actually serves traffic.

const workflows = readdirSync(DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => [f, readFileSync(join(DIR, f), 'utf8')])

test('no workflow deploys the retired express host', () => {
  const offenders = workflows
    .filter(([, body]) => /^\s*CHAT_DEPLOY_TARGET:\s*express\s*$/m.test(body))
    .map(([name]) => name)

  assert.deepEqual(
    offenders, [],
    `${offenders.join(', ')} set CHAT_DEPLOY_TARGET: express, so every push to the deployed ` +
    'branch re-creates the ECS Express stacks and restarts the ~$41/mo. The script default ' +
    'does not help — an explicit CI env var outranks it.'
  )
})

test('the deploy workflows target the streaming host explicitly', () => {
  const deployers = workflows.filter(([n]) => /deploy-(prod|staging)\.yml$/.test(n))
  assert.ok(deployers.length >= 2, 'expected both deploy workflows to exist')

  for (const [name, body] of deployers) {
    assert.match(
      body, /^\s*CHAT_DEPLOY_TARGET:\s*stream\s*$/m,
      `${name} must set CHAT_DEPLOY_TARGET: stream explicitly. Leaving it unset would work ` +
      'today but silently follows whatever the script default happens to be, which is the ' +
      'coupling that hid this bug.'
    )
  }
})
