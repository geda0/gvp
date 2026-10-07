/**
 * Chat request body hashing for the CloudFront + OAC front door.
 *
 * CloudFront with Origin Access Control in front of a Lambda Function URL requires the
 * viewer to supply the request-body hash. AWS documents it: for PUT/POST, users must
 * compute the SHA-256 of the body and send it in `x-amz-content-sha256`, and Lambda does
 * not accept unsigned payloads. Measured: without the header the edge returns
 * 403 InvalidSignatureException; `UNSIGNED-PAYLOAD` is rejected too, because Lambda
 * recomputes the hash over the real bytes.
 *
 * The digest must cover the EXACT bytes that are sent, so the payload is serialized once
 * and the same string is both hashed and returned as `body`. Never serialize twice.
 *
 * This is an unkeyed digest, not a signature: no credential enters the browser, which is
 * why it is safe to compute client-side.
 */

const toHex = (buffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

export async function buildChatRequest (payload) {
  const body = JSON.stringify(payload)
  // Degrade, don't throw: `crypto.subtle` exists only in a secure context, so over plain http
  // on localhost it is undefined. The caller awaits this inside its fetch `try`, so a throw
  // would surface as a retryable "could not reach the chat service". Drop only the header.
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    return { body, headers: { 'x-amz-content-sha256': toHex(digest) } }
  } catch (_) {
    return { body, headers: {} }
  }
}
