// ADR-0026 §5.4 + design-notes L3: after every stage and prod deploy, the deploy sends ONE
// `POST /api/chat {"warm":true}` through the CloudFront front door the browser uses, so the deploy
// (not the first visitor) pays the cold start, and the elapsed ms it echoes IS the post-deploy
// cold-start measurement. The product-owner's acceptance (chosen over the ADR's "warning only"):
// a non-2xx — the warm contract answers 204 — or a timeout FAILS the deploy job, with a message
// naming the environment.
//
// The front door is CloudFront + OAC to a Function URL, so a POST must carry
// `x-amz-content-sha256` = sha256(body) or it is refused 403 (ADR-0022 §7.7). The body and its
// hash are therefore asserted byte-for-byte here, against a real local server and real curl.
//
// The logic lives in scripts/lib/chat-warm.sh so it can be driven directly; sourcing
// integrate-and-deploy.sh would execute a deploy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(REPO, 'scripts/lib/chat-warm.sh')
const DEPLOY = readFileSync(join(REPO, 'scripts/integrate-and-deploy.sh'), 'utf8')

const run = (script, env = {}) => new Promise((resolve) => {
  execFile('bash', ['-c', `set -euo pipefail; . "${LIB}"; ${script}`],
    { env: { ...process.env, ...env }, timeout: 20000 },
    (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

async function withServer (handler, fn) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      handler(req, res)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/api/chat`
  try {
    return await fn(url, seen)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}

test('a 204 warm passes, and sends exactly {"warm":true} with its sha256 as x-amz-content-sha256', async () => {
  await withServer((req, res) => { res.statusCode = 204; res.end() }, async (url, seen) => {
    const r = await run(`chat_post_deploy_warm stage "${url}"`)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(seen.length, 1, 'exactly one warm request')
    const [req] = seen
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/api/chat')
    assert.equal(req.body, '{"warm":true}')
    assert.equal(req.headers['x-amz-content-sha256'], createHash('sha256').update('{"warm":true}').digest('hex'))
    assert.match(req.headers['content-type'], /^application\/json/)
    assert.match(r.stdout, /stage/)
    assert.match(r.stdout, /\b204\b/)
    assert.match(r.stdout, /\b\d+ ms\b/, 'the elapsed ms is the post-deploy cold-start measurement')
  })
})

for (const status of [503, 400, 200]) {
  test(`a ${status} warm fails, naming the environment`, async () => {
    await withServer((req, res) => { res.statusCode = status; res.end('{}') }, async (url) => {
      const r = await run(`chat_post_deploy_warm prod "${url}"`)
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, /prod/)
      assert.match(r.stderr, new RegExp(`\\b${status}\\b`))
    })
  })
}

test('a warm that times out fails, naming the environment', async () => {
  // The server never answers; CHAT_WARM_TIMEOUT_S bounds the wait.
  await withServer(() => {}, async (url) => {
    const r = await run(`chat_post_deploy_warm stage "${url}"`, { CHAT_WARM_TIMEOUT_S: '1' })
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /stage/)
    assert.match(r.stderr, /timed out|no response/i)
  })
})

test('the warm URL is the gvp:chat-api-url the browser uses, read from the committed HTML', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-warm-'))
  const html = join(dir, 'index.html')
  writeFileSync(html, '<head>\n    <meta name="gvp:contact-api-url" content="https://c.example/api/contact" />\n    <meta name="gvp:chat-api-url" content="https://d2lw3pyns4zzyb.cloudfront.net/api/chat" />\n</head>\n')
  const r = await run(`chat_front_door_url "${html}"`)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'https://d2lw3pyns4zzyb.cloudfront.net/api/chat')

  writeFileSync(html, '<head></head>\n')
  const none = await run(`chat_front_door_url "${html}"`)
  assert.equal(none.stdout.trim(), '')
})

test('integrate-and-deploy.sh sources the warm helper', () => {
  assert.match(DEPLOY, /^\. "\$\{ROOT\}\/scripts\/lib\/chat-warm\.sh"/m)
})

test('integrate-and-deploy.sh warms the front door right after the stream /health read, and a failed warm fails the deploy', () => {
  const health = DEPLOY.search(/curl [^\n]*\/health"/)
  const warm = DEPLOY.search(/chat_post_deploy_warm "\$\{DEPLOY_ENV\}" "\$\{CHAT_WARM_URL\}"/)
  assert.ok(health > -1, 'the stream /health read is gone')
  assert.ok(warm > health, 'the warm must follow the /health read')
  const call = DEPLOY.slice(warm, DEPLOY.indexOf('\n', warm))
  assert.doesNotMatch(call, /\|\|\s*(true|:|echo)/, 'a failed warm must not be swallowed')
  // The URL is the browser's front door (the committed meta), not a guessed host.
  assert.match(DEPLOY, /CHAT_WARM_URL="\$\(chat_front_door_url "\$\{ROOT\}\/index\.html"\)"/)
})
