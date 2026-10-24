import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { buildChatRequest } from '../js/chat-payload-hash.js'
import { createChatPrewarm } from '../js/chat-prewarm.js'

// L2 (ADR-0026 §5.2-§5.3): the first sign of chat intent sends ONE throwaway warm request so
// the stream Lambda's cold start is paid before the visitor's first real message. The warm
// goes through the same CloudFront + OAC front door as a turn, so it carries the same
// payload digest (`x-amz-content-sha256` over the exact body bytes) — built by
// buildChatRequest, never by hand, or the warm is a 403 that quietly warms nothing.

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
// crypto.subtle.digest settles on the thread pool, not on the next tick: give it real time.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('trigger sends one warm POST whose digest covers its exact body', async () => {
  // Arrange
  const calls = []
  const prewarm = createChatPrewarm({
    chatApiUrl: 'https://chat.example.test/api/chat',
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 204 } },
    buildRequest: buildChatRequest
  })

  // Act
  prewarm.trigger()
  await settle()

  // Assert
  const [call] = calls
  assert.deepEqual(
    {
      count: calls.length,
      url: call?.url,
      method: call?.opts?.method,
      body: call?.opts?.body,
      digestMatchesBody: call?.opts?.headers?.['x-amz-content-sha256'] === sha256(String(call?.opts?.body))
    },
    {
      count: 1,
      url: 'https://chat.example.test/api/chat',
      method: 'POST',
      body: '{"warm":true}',
      digestMatchesBody: true
    },
    'the warm is POST {"warm":true} to the chat route with the digest of those exact bytes ' +
    '(ADR-0026 §5.1) — the warm path is not a digest bypass'
  )
})
