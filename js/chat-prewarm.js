/**
 * Chat prewarm (ADR-0026 §5.2-§5.3): on the first sign of chat intent, send one throwaway
 * `POST {"warm":true}` so the stream Lambda's cold start is paid before the visitor's first
 * real message. The server answers 204 without calling the model or writing a turn.
 *
 * The body and its `x-amz-content-sha256` come from `buildRequest` (buildChatRequest in
 * js/chat-payload-hash.js) — the CloudFront + OAC front door rejects a body whose digest does
 * not match, and hand-writing the header elsewhere is how that mismatch ships.
 *
 * `trigger()` fires at most once per page load (one instance per page; later calls are
 * no-ops, so re-opening the chat sends nothing), does nothing without a URL, and never throws
 * or surfaces UI: a failed warm is swallowed and never retried. It is fire-and-forget, so it
 * cannot delay the visitor's first real message.
 */
export function createChatPrewarm ({ chatApiUrl, fetchImpl, buildRequest } = {}) {
  let fired = false
  const trigger = () => {
    if (fired || !chatApiUrl) return
    fired = true
    void (async () => {
      try {
        const { body, headers } = await buildRequest({ warm: true })
        await fetchImpl(chatApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body
        })
      } catch (_) {}
    })()
  }
  return { trigger }
}
