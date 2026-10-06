import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { buildChatRequest } from '../js/chat-payload-hash.js'

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
