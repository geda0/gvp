import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { hashIp, buildMessageRecord } from '../aws/src/common/contact-shared.js'

// ADR-0008 SEC-2: `hashIp(ip, pepper)` becomes a KEYED hash —
// HMAC-SHA256(pepper, ip) rendered hex and sliced to 16 chars — so without the
// pepper an attacker cannot rainbow-table `ipHash` back to the source IP. This
// pins the single S1 behavior: keyed output, ≠ the legacy unkeyed SHA-256, and
// deterministic per (ip, pepper) but pepper-sensitive.
test('hashIp keys the IP with the pepper (HMAC-SHA256, 16 hex), differs from the legacy unkeyed hash, and is pepper-deterministic', () => {
  // Arrange
  const ip = '203.0.113.7'
  const pepper = 'pepper-one'
  const otherPepper = 'pepper-two'
  const expected = crypto
    .createHmac('sha256', pepper)
    .update(ip)
    .digest('hex')
    .slice(0, 16)
  const legacyUnkeyed = crypto
    .createHash('sha256')
    .update(ip)
    .digest('hex')
    .slice(0, 16)

  // Act
  const keyed = hashIp(ip, pepper)
  const keyedAgain = hashIp(ip, pepper)
  const keyedOtherPepper = hashIp(ip, otherPepper)

  // Assert: it is the keyed HMAC, rendered hex and sliced to 16 chars
  assert.equal(keyed, expected)
  // ...which proves it is actually keyed, not the old unkeyed SHA-256
  assert.notEqual(keyed, legacyUnkeyed)
  // ...deterministic for the same (ip, pepper)
  assert.equal(keyed, keyedAgain)
  // ...but a different pepper yields a different hash for the same ip
  assert.notEqual(keyed, keyedOtherPepper)
})

// ADR-0008 SEC-2 fail-safe: without a pepper there is no key, so the hash would
// degrade to the reversible unkeyed SHA-256 — exactly the rainbow-table exposure
// the keyed hash exists to prevent. `hashIp` therefore FAILS SAFE: an empty or
// missing pepper returns '' (the documented non-IP fallback), NEVER the legacy
// unkeyed hash. This pins that an attacker can't trick the helper into emitting
// a reversible value by withholding the key.
test('hashIp fails safe to empty string with no/empty pepper, never the reversible unkeyed hash', () => {
  // Arrange
  const ip = '203.0.113.7'
  const legacyUnkeyed = crypto
    .createHash('sha256')
    .update(ip)
    .digest('hex')
    .slice(0, 16)

  // Act
  const noPepper = hashIp(ip)
  const emptyPepper = hashIp(ip, '')

  // Assert: the fallback is the documented non-IP empty string...
  assert.equal(noPepper, '')
  assert.equal(emptyPepper, '')
  // ...and crucially NOT the reversible unkeyed SHA-256 of the IP
  assert.notEqual(noPepper, legacyUnkeyed)
  assert.notEqual(emptyPepper, legacyUnkeyed)
})

// ADR-0008 SEC-2 (tdd-critic gap S3b): the CONTACT ingress path must key the
// visitor IP exactly like the EVENT path so one visitor yields the SAME ipHash
// across both tables. x-forwarded-for is "client, proxy1, proxy2" — only the
// LEFTMOST entry is the real visitor (mirrors events-shared.js `.split(',')[0]`).
// `buildMessageRecord` must therefore hash the keyed HMAC of just 'CLIENT_IP',
// never the whole "CLIENT_IP, proxy1" string, never the raw IP, never the
// reversible unkeyed hash — and FAIL SAFE to '' with no pepper. We mutate
// process.env, so save/restore the prior value.
test('buildMessageRecord keys the leftmost x-forwarded-for client IP, matching the events ipHash, never the whole header/raw/unkeyed, and empty without a pepper', () => {
  const prevPepper = process.env.IP_HASH_PEPPER
  try {
    // Arrange
    const clientIp = '203.0.113.7'
    const fullXff = `${clientIp}, 70.0.0.1`
    const pepper = 'contact-pepper'
    process.env.IP_HASH_PEPPER = pepper
    const expectedLeftmostKeyed = crypto
      .createHmac('sha256', pepper)
      .update(clientIp)
      .digest('hex')
      .slice(0, 16)
    const wholeHeaderKeyed = crypto
      .createHmac('sha256', pepper)
      .update(fullXff)
      .digest('hex')
      .slice(0, 16)
    const legacyUnkeyed = crypto
      .createHash('sha256')
      .update(clientIp)
      .digest('hex')
      .slice(0, 16)

    // Act
    const record = buildMessageRecord(
      { email: 'visitor@example.com', message: 'hi' },
      { 'x-forwarded-for': fullXff }
    )

    // Assert: keyed HMAC of the LEFTMOST client IP (same value the events path stores)
    assert.equal(record.ipHash, expectedLeftmostKeyed, 'ipHash must be the keyed HMAC of the leftmost client IP')
    // ...not the keyed hash of the whole "client, proxy1" header
    assert.notEqual(record.ipHash, wholeHeaderKeyed, 'ipHash must key only the leftmost IP, not the full XFF header')
    // ...not the raw IP, not the reversible unkeyed hash
    assert.notEqual(record.ipHash, clientIp, 'the raw IP must never be stored')
    assert.notEqual(record.ipHash, legacyUnkeyed, 'ipHash must not be the reversible unkeyed hash')
    // ...and no raw IP anywhere in the serialized row
    assert.doesNotMatch(JSON.stringify(record), /203\.0\.113\.7/, 'no raw IP anywhere in the row')

    // Fail safe: no pepper -> empty ipHash
    delete process.env.IP_HASH_PEPPER
    const unpeppered = buildMessageRecord(
      { email: 'visitor@example.com', message: 'hi' },
      { 'x-forwarded-for': fullXff }
    )
    assert.equal(unpeppered.ipHash, '', 'ipHash must be empty when IP_HASH_PEPPER is unset')
  } finally {
    if (prevPepper === undefined) delete process.env.IP_HASH_PEPPER
    else process.env.IP_HASH_PEPPER = prevPepper
  }
})
