/**
 * Chat prewarm (ADR-0026 §5.2-§5.3): on the first sign of chat intent, send one throwaway
 * `POST {"warm":true}` so the stream Lambda's cold start is paid before the visitor's first
 * real message. The server answers 204 without calling the model or writing a turn.
 *
 * The body and its `x-amz-content-sha256` come from `buildRequest` (buildChatRequest in
 * js/chat-payload-hash.js) — the CloudFront + OAC front door rejects a body whose digest does
 * not match, and hand-writing the header elsewhere is how that mismatch ships.
 */
export function createChatPrewarm ({ chatApiUrl, fetchImpl, buildRequest } = {}) {
  const trigger = () => {
    void (async () => {
      const { body, headers } = await buildRequest({ warm: true })
      await fetchImpl(chatApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body
      })
    })()
  }
  return { trigger }
}
