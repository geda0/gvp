import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const JS_DIR = join(REPO, 'js')

const ALLOWED_URL_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.googletagmanager.com',
  'www.w3.org'
])

function stripJsComments (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
}

function findHardcodedUrlHosts (source) {
  const stripped = stripJsComments(source)
  const hits = []
  const re = /https?:\/\/([a-zA-Z0-9][-a-zA-Z0-9.]*[a-zA-Z0-9])(?=[:/?#'"\s]|$)/g
  let m
  while ((m = re.exec(stripped)) !== null) {
    const host = m[1]
    if (!ALLOWED_URL_HOSTS.has(host)) hits.push({ host, index: m.index })
  }
  return hits
}

test('js modules do not hardcode cross-origin API hosts', () => {
  const jsFiles = readdirSync(JS_DIR).filter((n) => n.endsWith('.js'))
  assert.ok(jsFiles.length > 0)

  for (const name of jsFiles) {
    const source = readFileSync(join(JS_DIR, name), 'utf8')
    const hits = findHardcodedUrlHosts(source)
    assert.equal(
      hits.length,
      0,
      `${name} must not hardcode remote API hosts (found: ${hits.map((h) => h.host).join(', ')})`
    )
  }
})

test('network consumers resolve bases from site-config exports', () => {
  const contact = readFileSync(join(JS_DIR, 'contact.js'), 'utf8')
  const chat = readFileSync(join(JS_DIR, 'chat.js'), 'utf8')
  const live = readFileSync(join(JS_DIR, 'chat-live.js'), 'utf8')

  assert.match(contact, /import\s*\{\s*contactApiUrl\s*\}\s*from\s*['"]\.\/site-config\.js['"]/)
  assert.match(chat, /import\s*\{\s*chatApiUrl\s*\}\s*from\s*['"]\.\/site-config\.js['"]/)
  assert.match(live, /import\s*\{\s*chatApiUrl\s*\}\s*from\s*['"]\.\/site-config\.js['"]/)
})

test('site-config uses meta tags with localhost-only same-origin fallbacks', () => {
  const source = readFileSync(join(JS_DIR, 'site-config.js'), 'utf8')
  assert.match(source, /resolveApiUrl\(/)
  assert.match(source, /gvp:contact-api-url/)
  assert.match(source, /gvp:chat-api-url/)
  assert.match(source, /localhost.*127\.0\.0\.1|127\.0\.0\.1.*localhost/)
  assert.match(source, /['"]\/api\/contact['"]/)
  assert.match(source, /['"]\/api\/chat['"]/)
})

test('voice WebSocket URL comes from the minted session body, not a hardcoded host', () => {
  const source = readFileSync(join(JS_DIR, 'chat-live.js'), 'utf8')
  assert.match(source, /\{\s*websocketUrl\s*,\s*handshake\s*\}\s*=\s*body/)
  assert.doesNotMatch(source, /new\s+WebSocket\s*\(\s*['"]wss?:\/\//)
  assert.match(source, /new\s+WebSocket\s*\(\s*websocketUrl\s*\)/)
})
