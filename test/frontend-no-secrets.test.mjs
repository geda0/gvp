import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** Shipped static frontend surfaces (HTML/CSS/JS) — not Lambda, not chat backend. */
function collectFrontendFiles () {
  const paths = [
    join(REPO, 'index.html'),
    join(REPO, 'admin', 'index.html')
  ]
  for (const name of readdirSync(join(REPO, 'css'))) {
    if (name.endsWith('.css')) paths.push(join(REPO, 'css', name))
  }
  for (const name of readdirSync(join(REPO, 'js'))) {
    if (name.endsWith('.js')) paths.push(join(REPO, 'js', name))
  }
  return paths
}

const SECRET_PATTERNS = [
  { label: 'Gemini API key', re: /AIza[0-9A-Za-z_-]{20,}/ },
  { label: 'Resend API key', re: /\bre_[0-9A-Za-z]{20,}\b/ },
  { label: 'sk- prefixed secret', re: /\bsk-[a-zA-Z0-9]{20,}\b/ }
]

test('shipped frontend bundle contains no secret-shaped literals', () => {
  const files = collectFrontendFiles()
  assert.ok(files.length > 5, 'expected html/css/js frontend files to scan')

  for (const path of files) {
    const rel = path.slice(REPO.length + 1)
    const text = readFileSync(path, 'utf8')
    for (const { label, re } of SECRET_PATTERNS) {
      const hit = re.exec(text)
      assert.ok(!hit, `${rel} must not contain ${label} (matched ${hit?.[0]?.slice(0, 12)}…)`)
    }
  }
})

test('index.html API config is meta tags plus public GA measurement id only', () => {
  const html = readFileSync(join(REPO, 'index.html'), 'utf8')

  const apiMetaNames = [...html.matchAll(/<meta\s+name="([^"]+)"\s+content="https?:\/\/[^"]*"/gi)]
    .map((m) => m[1])
  assert.deepEqual(
    apiMetaNames.sort(),
    ['gvp:chat-api-url', 'gvp:contact-api-url'],
    'remote API bases must come only from the two gvp:* meta tags'
  )

  assert.match(html, /gtag\/js\?id=G-EYTRKC93DL/, 'public GA measurement id is allowed')
  assert.doesNotMatch(html, /AIza|re_[0-9A-Za-z]{10,}/, 'index.html must not embed provider keys')
})

test('admin/index.html exposes only public API meta tags (no key material)', () => {
  const html = readFileSync(join(REPO, 'admin', 'index.html'), 'utf8')
  const apiMetaNames = [...html.matchAll(/<meta\s+name="([^"]+)"\s+content="https?:\/\/[^"]*"/gi)]
    .map((m) => m[1])
  // The dashboard also carries the PUBLIC chat host URL (gvp:chat-api-url) so it can run the
  // deep live-smoke probe against the chat host. That host is already public (the main site
  // ships it); the actual security invariant — no provider key material — is asserted below.
  assert.deepEqual(apiMetaNames.sort(), ['gvp:chat-api-url', 'gvp:contact-api-url'])
  assert.doesNotMatch(html, /AIza|re_[0-9A-Za-z]{10,}/)
})
