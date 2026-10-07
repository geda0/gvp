import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { buildChatRequest } from '../js/chat-payload-hash.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function stripJsComments (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
}

// ADR-0022 §7.7 / §24.6: with CloudFront + OAC in front of the RESPONSE_STREAM
// Lambda function URL, every chat POST must carry
// `x-amz-content-sha256: hex(SHA-256(body))` — AWS documents that "Lambda doesn't
// support unsigned payloads", and `UNSIGNED-PAYLOAD` measured 403
// InvalidSignatureException while the true body hash measured 200
// text/event-stream. Until the frontend sends this header the new chat front door
// cannot be pointed at a browser.
//
// What this pins is NOT "can we compute a SHA-256" — it is that the digest is
// taken over the EXACT bytes that get sent. An implementation that serializes once
// for the hash and again for the body agrees with itself only while
// JSON.stringify happens to be stable, and then returns an intermittent 403 at the
// edge that is indistinguishable from a misconfiguration. So the seam hands back
// the body it hashed (`{ body, headers }`), and the payload below is deliberately
// NOT serialization-stable — `sessionId` changes on every read, standing in for any
// per-access value (a nonce, a timestamp) — so a serialize-twice implementation
// cannot produce a header that matches the body it returns.
//
// The expectation comes from an INDEPENDENT oracle (node:crypto, not the
// crypto.subtle the module uses) applied to the body the module returns; the test
// never re-serializes the payload. The oracle is anchored to the published
// FIPS 180-4 vector for "abc" so the expectation cannot be a shared-bug artifact.
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

test('the chat request carries the SHA-256 of the exact body bytes it hands back for sending', async () => {
  // Arrange — a chat payload that serializes differently on every stringify.
  let sessionIdReads = 0
  const messages = [{ role: 'user', content: 'where can I read your résumé?' }]
  const payload = {
    messages,
    stream: true,
    language: 'en',
    get sessionId () {
      sessionIdReads += 1
      return `session-${sessionIdReads}`
    }
  }

  // Act
  const request = await buildChatRequest(payload)

  // Assert
  assert.equal(sha256Hex('abc'), SHA256_OF_ABC)
  assert.deepEqual(JSON.parse(request.body).messages, messages)
  assert.equal(request.headers['x-amz-content-sha256'], sha256Hex(request.body))
})

// REGRESSION (local dev over http). `crypto.subtle` exists only in a SECURE context.
// `js/site-config.js:5-12` falls back to a same-origin `/api/chat` when the hostname is
// `localhost` / `127.0.0.1` — commonly plain http, where the browser exposes `crypto` but
// `crypto.subtle` is `undefined`, so the digest cannot be computed. `js/chat.js:1157` awaits
// `buildChatRequest` INSIDE the try whose `catch (_)` means "fetch failed", so a throw here
// is reported as `makeRetryableError('Could not reach the chat service…')` — a misleading
// network error that is also marked RETRYABLE, so it can spin retries — for a request that
// would have succeeded without the header (dev talks to a local server / ECS / API Gateway,
// none of which require it; only CloudFront + OAC does).
//
// The digest concern belongs to THIS helper, so the helper degrades instead of making every
// caller defend itself: same body, NO digest header. The caller's `...headers` spread of `{}`
// is a no-op, so the POST goes out exactly as it did before the digest slice existed. Nothing
// throws, so `js/chat.js` needs no change and its catch keeps its single meaning.
//
// The absence is simulated by swapping `globalThis.crypto` for an insecure-context stand-in
// — `getRandomValues` present, `subtle` absent, which is precisely what a browser exposes
// over http (both `subtle` and `randomUUID` are `[SecureContext]`, `getRandomValues` is not).
// It uses the repo's existing `Object.defineProperty(globalThis, …)` + restore-in-`finally`
// idiom (`test/site-events-session.test.mjs:77-108`): Node's global `crypto` is a
// non-writable but CONFIGURABLE accessor, so plain assignment would throw. The real object is
// restored before any assertion runs, so nothing leaks into the next test, and the helper's
// signature is untouched — it keeps reading the ambient `crypto`, as a browser module must.
//
// A `crypto.subtle` that is PRESENT but whose `digest` rejects is the same clause of the same
// contract and is deliberately NOT pinned here (one behavior per test); a `try/catch` around
// the digest covers both, but only the missing-`subtle` corner is proven by this file.
//
// The happy path is not re-asserted here — the first test above already pins the real digest,
// so a degrade-always `return { body, headers: {} }` cannot satisfy this cycle.
test('still hands back the body with no digest header when the context has no crypto.subtle', async () => {
  // Arrange — an insecure context: `crypto` without `subtle`.
  const payload = {
    messages: [{ role: 'user', content: 'hello from http://localhost:8000' }],
    stream: true,
    sessionId: 'session-insecure-context',
    language: 'en'
  }
  const realCrypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: (array) => realCrypto.getRandomValues(array) },
    configurable: true,
    writable: true
  })

  // Act
  let request = null
  let thrown = null
  try {
    request = await buildChatRequest(payload)
  } catch (error) {
    thrown = error
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true, writable: true })
  }

  // Assert
  assert.equal(
    thrown,
    null,
    'buildChatRequest must degrade when the digest cannot be computed, not throw — a throw lands in the fetch catch of js/chat.js as a RETRYABLE "Could not reach the chat service". It threw: ' +
      (thrown ? thrown.message : '(nothing)')
  )
  assert.deepEqual(
    JSON.parse(request.body),
    payload,
    'the degraded request must still carry the single serialization of the payload as its body'
  )
  assert.deepEqual(
    request.headers,
    {},
    'with no digest available the request must go out with no digest header, so the caller spread is a no-op'
  )
})

// The seam above is worthless until the sender uses it: today `js/chat.js` still builds
// `body: JSON.stringify({...})` inline, so no chat POST carries a digest and the
// CloudFront + OAC front door answers 403 InvalidSignatureException. Asserted at SOURCE
// level on purpose — `js/chat.js` is not importable under `node --test` (it touches
// `document` at import time, so a fake-`fetch` test is impossible), and the defect being
// prevented, *hashing one string while sending another*, is a property of the source: a
// second `JSON.stringify` in that file is how the body and its digest drift apart. Same
// idiom as `test/frontend-api-config.test.mjs` / `test/frontend-no-secrets.test.mjs`,
// which already guard the shipped frontend by reading it.
//
// The header goes out unconditionally — ECS and API Gateway ignore an unknown header, and
// host-sniffing in the frontend would be new drift.
test('the shipped chat POST takes its body from the hashing seam and attaches the digest header', () => {
  // Arrange — the shipped module, comments removed so prose about JSON.stringify cannot
  // satisfy or break the count.
  const source = stripJsComments(readFileSync(join(REPO, 'js', 'chat.js'), 'utf8'))

  // Act — one serialization site must remain: the unrelated prefill dataset write.
  const serializationSites = source.match(/JSON\.stringify/g) || []

  // Assert
  assert.match(
    source,
    /import\s*\{[^}]*\bbuildChatRequest\b[^}]*\}\s*from\s*['"]\.\/chat-payload-hash\.js['"]/,
    'js/chat.js must import buildChatRequest from ./chat-payload-hash.js'
  )
  assert.match(source, /buildChatRequest\s*\(/, 'js/chat.js must actually call buildChatRequest')
  assert.match(
    source,
    /\.\.\.\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?headers\b/,
    "the seam's headers must be merged into the POST headers (e.g. `...headers`), or no digest reaches the edge"
  )
  assert.equal(
    serializationSites.length,
    1,
    'js/chat.js must serialize the chat body exactly once — via buildChatRequest, not inline'
  )
  assert.match(
    source,
    /dataset\.prefill\s*=\s*JSON\.stringify\(/,
    'the one surviving JSON.stringify must be the prefill dataset write, not the POST body'
  )
})
