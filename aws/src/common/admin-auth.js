// M8 item 6 (ADR-0021) — who may do what on the admin API. SDK-free so it is unit-tested
// without @aws-sdk; contact-admin.js only wires it.
//
// ADMIN_API_KEY = full access. ADMIN_READONLY_KEY (optional) = every GET, and a 403 on every
// mutation. Both compare in constant time over SHA-256 digests, so neither the key length nor
// a matching prefix leaks through timing. A read-only key equal to the full key is a full key.
import crypto from 'node:crypto'

function safeEqual(expected, provided) {
  if (!expected || typeof provided !== 'string' || !provided) return false
  const eh = crypto.createHash('sha256').update(expected, 'utf8').digest()
  const ph = crypto.createHash('sha256').update(provided, 'utf8').digest()
  return crypto.timingSafeEqual(eh, ph)
}

export function adminAccess(headers, env = process.env) {
  const provided = headers?.['x-admin-key'] || headers?.['X-Admin-Key'] || ''
  try {
    if (safeEqual(env.ADMIN_API_KEY, provided)) return 'full'
    if (safeEqual(env.ADMIN_READONLY_KEY, provided)) return 'readonly'
  } catch {
    return null
  }
  return null
}

const READ_METHODS = new Set(['GET', 'HEAD'])

export function adminDecision(access, method) {
  if (!access) return { ok: false, status: 401, code: 'unauthorized' }
  if (access === 'readonly' && !READ_METHODS.has(String(method).toUpperCase())) {
    return { ok: false, status: 403, code: 'admin_readonly' }
  }
  return { ok: true }
}
