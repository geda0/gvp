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

// ---------------------------------------------------------------------------
// Invariant 18, pin 1 (ADR-0022 §24.7) — the shipped frontend emits the streaming
// chat route in exactly ONE spelling, by contract rather than by accident.
//
// Every assert above this line reads file TEXT. That is the wrong shape for this
// property: a rewrite of the normalisation could keep satisfying a regex while no
// longer normalising. So this one drives the real derivation and reads its OUTPUT
// for each meta spelling a human could plausibly commit.
//
// A trailing slash is not cosmetic. `/api/chat/` misses the exact CloudFront
// behavior and either (a) falls through to the default behavior on the buffered API
// Gateway origin — a 200, text/event-stream, correct text, delivered all at once, so
// streaming is silently dead with no error anywhere — or (b) with a second exact
// behavior on the streaming origin, draws FastAPI's redirect_slashes 307 whose
// Location names the private Function URL host, which an unsigned browser follow
// answers 403.
//
// Mechanics: site-config.js reads `document` at MODULE-LOAD time, and static imports
// hoist above any stub, so each case installs a minimal document/window and then
// loads the module through a dynamic import() carrying a cache-busting query string
// (ESM caches by specifier, so the query is what buys a fresh evaluation per
// spelling — one import would only ever exercise one spelling).

const CHAT_META = 'gvp:chat-api-url'

// The endpoint that actually ships, per deploy target: the prod value injected at
// deploy, the stage value committed in index.html, and the same-origin relative
// form. Each is already the single legal spelling.
const CANONICAL_ENDPOINTS = [
  'https://gv-0277d83a39d54698a254a52e95dcd476.ecs.us-east-2.on.aws/api/chat',
  'https://d2lw3pyns4zzyb.cloudfront.net/api/chat',
  '/api/chat'
]

// Spellings of one canonical endpoint that a human editing the <meta> could emit.
const SPELLINGS = [
  (url) => url,
  (url) => `${url}/`,
  (url) => `${url}///`,
  (url) => `  ${url}  `,
  (url) => ` \t${url}/\n`,
  (url) => `\n ${url}///  `
]

// Derive the endpoint js/chat.js would POST to, for one <meta> content value.
async function deriveChatApiUrl (metaContent) {
  const saved = { window: globalThis.window, document: globalThis.document }
  const define = (key, value) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })

  // hostname is deliberately NOT localhost: the localhost fallback must never be
  // what makes a case pass.
  define('window', { location: { hostname: 'example.test' } })
  define('document', {
    querySelector: (sel) => (sel.includes(CHAT_META) ? { getAttribute: () => metaContent } : null)
  })

  try {
    const bust = encodeURIComponent(metaContent)
    const mod = await import(`../js/site-config.js?spelling=${bust}`)
    return mod.chatApiUrl
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]
      else define(k, v)
    }
  }
}

test('every chat-api-url meta spelling derives exactly <base>/api/chat', async () => {
  // Arrange — each shipping endpoint crossed with every spelling of it.
  const expected = {}
  for (const canonical of CANONICAL_ENDPOINTS) expected[canonical] = SPELLINGS.map(() => canonical)

  // Act — load a fresh site-config against each spelling, read chatApiUrl.
  const derived = {}
  for (const canonical of CANONICAL_ENDPOINTS) {
    derived[canonical] = []
    for (const spell of SPELLINGS) derived[canonical].push(await deriveChatApiUrl(spell(canonical)))
  }

  // Assert — every spelling collapses onto the one canonical endpoint...
  assert.deepEqual(derived, expected)

  // ...and that endpoint is <base>/api/chat: no trailing slash, no doubled separator.
  for (const canonical of CANONICAL_ENDPOINTS) {
    assert.match(canonical, /^(https:\/\/[^/]+)?\/api\/chat$/)
  }
})
