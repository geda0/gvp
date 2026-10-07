import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ADR-0020 §5 A7b. The admin chat rollup counts tool names and transports with
// `h[k] = (h[k] || 0) + 1`, where `k` is a caller-supplied tool `name` that
// arrives through the UNAUTHENTICATED /api/live/transcript sink. On a plain `{}`
// a key that collides with Object.prototype resolves to an INHERITED FUNCTION,
// which is truthy, so `function + 1` concatenates: a tool named `toString` makes
// the count the STRING 'function toString() { [native code] }11', and
// `__proto__` silently drops the bucket instead. Both land where the dashboard
// renders a number, and the toolHistogram garbage then compounds through the
// summary merge. (Object.prototype itself is NOT polluted — this is a key
// collision with a wrong value type, scoped to the response being built.)
//
// The fix is the backing object, not the increment: an accumulator with no
// prototype inherits nothing, so every key resolves to `undefined` and the
// `|| 0` branch does its job.
//
// Asserted at the SOURCE level on purpose. `aws/src/contact-admin.js` imports
// `@aws-sdk/*` at module scope and this histogram logic exists only there, with
// no SDK-free core — and the always-present `node --test` floor must stay
// install-free (see test/contact-core-no-aws-sdk.test.mjs), because a test that
// imported the handler would pass locally off a cached `aws/src/node_modules`
// and fail CI on a clean checkout. Same readFileSync idiom as
// test/frontend-api-config.test.mjs and test/frontend-no-secrets.test.mjs.
const ADMIN_SOURCE = fileURLToPath(new URL('../aws/src/contact-admin.js', import.meta.url))

// The caller-keyed counter family, matched by NAME rather than by six
// hand-written string matches, so a seventh counter added later as a plain `{}`
// is caught without touching this test.
const COUNTER_NAMES = 'errorsByCode|transports|toolHistogram'

// An initializer, not a read: the name must be immediately followed by `=` or
// `:` and a fresh empty object literal. This deliberately does not match
// `item.transports || {}` (a fallback), `transports: item.transports` (a
// passthrough), or `transports[t] = ...` (a bump).
const PLAIN_OBJECT_INIT = new RegExp(`(${COUNTER_NAMES})\\s*[=:]\\s*\\{\\s*\\}`, 'g')
const NULL_PROTO_INIT = new RegExp(`(${COUNTER_NAMES})\\s*[=:]\\s*Object\\.create\\(\\s*null\\s*\\)`, 'g')

// Six today: normalizeChatItem's errorsByCode / transports / toolHistogram, and
// the summary's voice.toolHistogram / voice.transports / stream.errorsByCode.
const KNOWN_COUNTER_COUNT = 6

function stripJsComments (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
}

test('admin rollup counters are prototype-free, so a tool named toString counts as a number', () => {
  const source = stripJsComments(readFileSync(ADMIN_SOURCE, 'utf8'))

  const plain = [...source.matchAll(PLAIN_OBJECT_INIT)].map((m) => m[0].trim())
  const nullProto = [...source.matchAll(NULL_PROTO_INIT)].map((m) => m[1])

  assert.deepEqual(
    plain,
    [],
    'every caller-keyed counter in contact-admin.js must start from Object.create(null) — ' +
    `these still start from a plain {}, so an inherited Object.prototype key makes the count a string: ${plain.join(' | ')}`
  )
  assert.ok(
    nullProto.length >= KNOWN_COUNTER_COUNT,
    `expected at least the ${KNOWN_COUNTER_COUNT} known Object.create(null) counters ` +
    '(normalizeChatItem errorsByCode/transports/toolHistogram + summary voice.toolHistogram/voice.transports/stream.errorsByCode), ' +
    `found ${nullProto.length}: ${nullProto.join(', ')} — a counter that was renamed, deleted, or built some other way is not fixed`
  )
})
