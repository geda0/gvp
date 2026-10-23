// M8 item 6 (ADR-0021): an optional READ-ONLY admin key. It sees every dashboard (any GET)
// and every mutation answers 403 without the full key. Both keys compare in constant time.
// The access decision is an SDK-free core (aws/src/common/admin-auth.js) so it is testable
// without @aws-sdk; the handler wiring is pinned by reading contact-admin.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { adminAccess, adminDecision } from '../aws/src/common/admin-auth.js'

const env = { ADMIN_API_KEY: 'full-key-123', ADMIN_READONLY_KEY: 'ro-key-456' }
const h = (k) => ({ 'x-admin-key': k })

test('adminAccess: full key → full, read-only key → readonly, anything else → null', () => {
  assert.equal(adminAccess(h('full-key-123'), env), 'full')
  assert.equal(adminAccess({ 'X-Admin-Key': 'full-key-123' }, env), 'full')
  assert.equal(adminAccess(h('ro-key-456'), env), 'readonly')
  assert.equal(adminAccess(h('nope'), env), null)
  assert.equal(adminAccess({}, env), null)
  assert.equal(adminAccess(h(''), { ADMIN_API_KEY: 'full-key-123' }), null)
})

test('the read-only key is optional: unset or empty grants nothing, and never matches an empty header', () => {
  assert.equal(adminAccess(h('ro-key-456'), { ADMIN_API_KEY: 'full-key-123' }), null)
  assert.equal(adminAccess(h(''), { ADMIN_API_KEY: 'full-key-123', ADMIN_READONLY_KEY: '' }), null)
  assert.equal(adminAccess(h('x'), {}), null, 'no keys configured → no access')
})

test('a read-only key equal to the full key is refused, so it can never be a second full key', () => {
  assert.equal(adminAccess(h('same'), { ADMIN_API_KEY: 'same', ADMIN_READONLY_KEY: 'same' }), 'full')
})

test('adminDecision: GET passes for both; every other method is 403 for read-only', () => {
  assert.deepEqual(adminDecision('full', 'POST'), { ok: true })
  assert.deepEqual(adminDecision('readonly', 'GET'), { ok: true })
  assert.deepEqual(adminDecision('readonly', 'HEAD'), { ok: true })
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.deepEqual(adminDecision('readonly', m), { ok: false, status: 403, code: 'admin_readonly' })
  }
  assert.deepEqual(adminDecision(null, 'GET'), { ok: false, status: 401, code: 'unauthorized' })
})

test('contact-admin.js decides access through the core, before any route', () => {
  const src = readFileSync(new URL('../aws/src/contact-admin.js', import.meta.url), 'utf8')
  assert.match(src, /from '\.\/common\/admin-auth\.js'/)
  const handler = src.slice(src.indexOf('export const handler'))
  const decide = handler.search(/adminDecision\(adminAccess\(event\?\.headers \|\| \{\}\), method\)/)
  const firstRoute = handler.search(/const path = getPath\(event\)/)
  assert.ok(decide > -1 && decide < firstRoute, 'the decision must run before any route is matched')
  assert.doesNotMatch(src, /function requireAdminKey/, 'one access check, not two')
})

test('the template passes ADMIN_READONLY_KEY to the admin function, defaulting to empty', () => {
  const tpl = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8')
  assert.match(tpl, /^  AdminReadonlyKey:\s*\n\s+Type:\s*String\s*\n\s+NoEcho:\s*true\s*\n\s+Default:\s*''/m)
  assert.match(tpl, /ADMIN_READONLY_KEY:\s*!Ref AdminReadonlyKey/)
})
