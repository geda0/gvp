import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Guard against the 2026-06-04 incident: a fast-forward of `agent` -> `main` silently
// carried the STAGING API meta URLs onto `main`, and AWS Amplify (which serves the
// committed HTML as-is — there is no amplify.yml, and the deploy workflows run with
// SYNC_API_URLS=0) briefly published the staging contact + chat backends as production.
//
// `index.html` and `admin/index.html` legitimately DIVERGE between the two branches ONLY
// on the `gvp:*-api-url` meta tags:
//   main  (prod,    www.marwanelgendy.link)  -> lwi0vmdpb5.execute-api… + <express-prod>.ecs.us-east-2.on.aws
//   agent (staging, chat.marwanelgendy.link) -> fvfqpef8kb.execute-api… + <express-stage>.ecs.us-east-2.on.aws
//
// This guard pins that divergence: on `main` the shipped HTML MUST carry the prod hosts and
// MUST NOT carry any staging host; on `agent` the inverse. It is environment-gated so it never
// fails on a feature branch or a plain local `node --test`:
//   - explicit : GVP_EXPECTED_ENV=prod|stage           (set by the deploy workflows, fail-fast)
//   - automatic: GITHUB_REF_NAME main->prod, agent->stage (rides the existing CI `node --test`)
//   - otherwise: skipped.

const REPO = fileURLToPath(new URL('..', import.meta.url))

// Per-environment hosts. We pin the HOST (which backend), not the full path, so a legitimate
// path change does not trip the guard — the incident was a host swap, not a path change.
const ENV_HOSTS = {
  prod: {
    contact: 'lwi0vmdpb5.execute-api.us-east-2.amazonaws.com',
    // ADR-0007 Phase 4: prod chat migrated ECS+ALB -> ECS Express Mode (same managed successor
    // as staging; App Runner is maintenance-mode). Browser-direct voice => plain HTTP, so the
    // ECS-managed *.ecs.<region>.on.aws URL + TLS is all prod needs (no chat-api custom domain).
    chat: 'gv-0277d83a39d54698a254a52e95dcd476.ecs.us-east-2.on.aws'
  },
  stage: {
    contact: 'fvfqpef8kb.execute-api.us-east-2.amazonaws.com',
    // ADR-0007 Phase 3: staging chat is hosted on ECS Express Mode (AWS's managed successor
    // to App Runner, which entered maintenance mode 2026-04-30). Browser-direct voice means
    // no WS to host, so the ECS-managed *.ecs.<region>.on.aws URL + TLS is all staging needs.
    chat: 'gv-d7fa1a51ec09445caf0d435348131479.ecs.us-east-2.on.aws'
  }
}

function resolveExpectedEnv (env) {
  const explicit = String(env.GVP_EXPECTED_ENV || '').trim().toLowerCase()
  if (explicit === 'prod' || explicit === 'production') return 'prod'
  if (explicit === 'stage' || explicit === 'staging') return 'stage'
  if (explicit) return null // explicit but unrecognized -> do not guess an environment
  const branch = String(env.GITHUB_REF_NAME || '').trim()
  if (branch === 'main') return 'prod'
  if (branch === 'agent') return 'stage'
  return null
}

function metaUrl (html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = html.match(new RegExp(`<meta\\s+name="${escaped}"\\s+content="([^"]*)"`, 'i'))
  return m ? m[1] : null
}

function readFrontend (rel) {
  return readFileSync(join(REPO, rel), 'utf8')
}

const expected = resolveExpectedEnv(process.env)

if (!expected) {
  test('frontend API URL environment guard (skipped: no target environment)', {
    skip: 'set GVP_EXPECTED_ENV=prod|stage, or run on the main/agent branch in CI'
  }, () => {})
} else {
  const other = expected === 'prod' ? 'stage' : 'prod'
  const want = ENV_HOSTS[expected]
  const forbidden = ENV_HOSTS[other]
  const E = expected.toUpperCase()
  const O = other.toUpperCase()

  test(`index.html meta API hosts are ${E}, never ${O}`, () => {
    const html = readFrontend('index.html')
    const contact = metaUrl(html, 'gvp:contact-api-url')
    const chat = metaUrl(html, 'gvp:chat-api-url')

    assert.ok(contact, 'index.html is missing the gvp:contact-api-url meta tag')
    assert.ok(chat, 'index.html is missing the gvp:chat-api-url meta tag')

    assert.ok(contact.includes(want.contact), `contact meta must point at the ${expected} host ${want.contact} (got: ${contact})`)
    assert.ok(chat.includes(want.chat), `chat meta must point at the ${expected} host ${want.chat} (got: ${chat})`)

    assert.ok(!contact.includes(forbidden.contact), `contact meta must NOT carry the ${other} host ${forbidden.contact} — env leak: ${contact}`)
    assert.ok(!chat.includes(forbidden.chat), `chat meta must NOT carry the ${other} host ${forbidden.chat} — env leak: ${chat}`)
  })

  test(`admin/index.html contact meta host is ${E}, never ${O}`, () => {
    const html = readFrontend('admin/index.html')
    const contact = metaUrl(html, 'gvp:contact-api-url')

    assert.ok(contact, 'admin/index.html is missing the gvp:contact-api-url meta tag')
    assert.ok(contact.includes(want.contact), `admin contact meta must point at the ${expected} host ${want.contact} (got: ${contact})`)
    assert.ok(!contact.includes(forbidden.contact), `admin contact meta must NOT carry the ${other} host ${forbidden.contact} — env leak: ${contact}`)
  })

  test(`admin/index.html chat meta host is ${E}, never ${O}`, () => {
    // The dashboard's deep live-smoke probe calls the chat host from this meta; pin it to
    // the right environment so a stage chat host can never reach prod admin (or vice versa).
    const html = readFrontend('admin/index.html')
    const chat = metaUrl(html, 'gvp:chat-api-url')

    assert.ok(chat, 'admin/index.html is missing the gvp:chat-api-url meta tag')
    assert.ok(chat.includes(want.chat), `admin chat meta must point at the ${expected} host ${want.chat} (got: ${chat})`)
    assert.ok(!chat.includes(forbidden.chat), `admin chat meta must NOT carry the ${other} host ${forbidden.chat} — env leak: ${chat}`)
  })
}
