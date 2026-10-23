import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Does the site ship security headers, and does its CSP allow everything it actually does?
//
// M8 item 4. Amplify serves this repo as-is, so headers come from `customHttp.yml` — there
// is no server to set them in and no build step to generate them.
//
// A CSP IS THE ONE HEADER THAT CAN TAKE THE SITE DOWN BY BEING SLIGHTLY WRONG, which is why
// this file spends most of its length on the allow-list rather than on the presence of the
// header. Every origin below is one the shipped code actually contacts, read out of the
// markup and the modules rather than remembered:
//   - fonts.googleapis.com / fonts.gstatic.com   the two Google Fonts families
//   - www.googletagmanager.com                   gtag.js
//   - the contact API and the chat API           per-environment, so matched by WILDCARD
//   - generativelanguage.googleapis.com over WSS the browser opens Google's Live API
//     DIRECTLY with an ephemeral token (ADR-0007 Phase 1, `liveVoiceTransport:
//     direct_google`). This is the one nobody would guess from reading index.html, and
//     omitting it kills voice while leaving text chat working — a partial outage that would
//     read as a Gemini problem.
//
// WHY THE API HOSTS ARE WILDCARDS AND NOT PINNED. They differ between prod and stage, and
// the 2026-06-04 incident — a fast-forward that carried STAGING hosts onto production — is
// exactly what happens when a per-environment literal lives in a committed file. amplify.yml
// already carries a guard for that class of bug on the meta tags; adding a second file with
// the same hazard, to defend against script injection, would be trading one outage for
// another. The wildcards are our own AWS service domains, which is a bounded loosening.

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')

const CUSTOM_HTTP = join(REPO, 'customHttp.yml')

test('the repo ships a customHttp.yml for Amplify to serve', () => {
  assert.ok(
    existsSync(CUSTOM_HTTP),
    'Amplify publishes this repo as-is, so customHttp.yml is the only place headers can ' +
    'come from — there is no server and no build step'
  )
})

test('the headers that cost nothing and prevent whole classes of attack are present', () => {
  const yml = read('customHttp.yml')
  const required = {
    'X-Content-Type-Options': /nosniff/,
    'Referrer-Policy': /strict-origin-when-cross-origin|no-referrer/,
    'X-Frame-Options': /DENY|SAMEORIGIN/,
    'Strict-Transport-Security': /max-age=\d+/,
    'Permissions-Policy': /microphone=/
  }
  for (const [header, shape] of Object.entries(required)) {
    assert.match(yml, new RegExp(header, 'i'), `${header} is missing`)
    assert.match(yml, shape, `${header} is present but its value is not what it should be`)
  }

  // The site ASKS for the microphone (voice chat), so a blanket `microphone=()` would break
  // the feature. It must be allowed for self and nobody else.
  assert.match(
    yml, /microphone=\(self\)/,
    'voice chat needs the microphone, so Permissions-Policy must allow it for SELF — and ' +
    'only self, which is the whole point of naming it rather than leaving it default'
  )
})

test('the CSP allows every origin the shipped site actually talks to', () => {
  const yml = read('customHttp.yml')
  // Key and value on SEPARATE lines — the shape Amplify's own docs use, and the shape this
  // file is written in. The first version of this regex required them on one line and so
  // reported "no Content-Security-Policy found" against a file that had one.
  //
  // And the capture stops at the matching DOUBLE quote, not at any quote: a CSP is full of
  // single quotes (`'self'`, `'none'`), so a `[^"']` class truncates the policy at
  // `default-src ` and every directive after it reads as absent.
  const csp = /Content-Security-Policy['"]?\s*\n\s*value:\s*"([^"\n]+)"/i.exec(yml)
  assert.ok(csp, 'no Content-Security-Policy found in customHttp.yml')
  const policy = csp[1]

  const directive = (name) => {
    const m = new RegExp(`${name} ([^;]*)`).exec(policy)
    return m ? m[1].trim() : null
  }

  assert.match(directive('default-src') || '', /'self'/)

  // Google Fonts: a stylesheet from one host, the font files from another.
  assert.match(directive('style-src') || '', /fonts\.googleapis\.com/)
  assert.match(directive('font-src') || '', /fonts\.gstatic\.com/)

  // gtag.js
  assert.match(directive('script-src') || '', /googletagmanager\.com/)

  const connect = directive('connect-src') || ''
  assert.match(connect, /execute-api/, 'the contact API must be reachable')
  assert.match(connect, /cloudfront\.net/, 'the chat API must be reachable')
  assert.match(
    connect, /wss:\/\/generativelanguage\.googleapis\.com/,
    'THE ONE NOBODY GUESSES: the browser opens Google\'s Live API over WSS directly with an ' +
    'ephemeral token (ADR-0007 Phase 1). Omitting it kills VOICE while text chat keeps ' +
    'working — a partial outage that reads as a Gemini problem, not a header problem'
  )
  assert.match(connect, /google-analytics\.com|analytics\.google\.com/)

  // The clickjacking and injection floor.
  assert.match(directive('frame-ancestors') || '', /'none'/)
  assert.match(directive('object-src') || '', /'none'/)
  assert.match(directive('base-uri') || '', /'self'/)
  assert.match(directive('form-action') || '', /'self'/)
})

test('the CSP pins no per-environment host, so stage and prod can share one file', () => {
  // The 2026-06-04 incident was a fast-forward that carried STAGING API hosts onto
  // production. amplify.yml exists to catch that on the meta tags. A committed CSP with a
  // literal per-environment host would reintroduce exactly that hazard in a second file —
  // and its failure mode is worse, because a blocked connect-src is silent in the UI.
  const yml = read('customHttp.yml')
  const html = read('index.html')
  const liveHosts = [...html.matchAll(/content="https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1])
    .filter((h) => /execute-api|cloudfront/.test(h))

  assert.ok(liveHosts.length > 0, 'harness: no API hosts found in index.html')
  for (const host of liveHosts) {
    assert.doesNotMatch(
      yml, new RegExp(host.replace(/\./g, '\\.')),
      `customHttp.yml pins ${host}, which is this branch's environment. Use a wildcard — a ` +
      'per-environment literal in a committed file is the 2026-06-04 incident again, and a ' +
      'blocked connect-src shows nothing in the UI'
    )
  }
})

test("'unsafe-inline' in script-src is recorded as a residual, not left unexplained", () => {
  // The site has no build step, so inline handlers and the gtag bootstrap cannot be
  // nonce'd. That is a real weakening and it stays — but an unexplained 'unsafe-inline' is
  // indistinguishable from a copy-pasted policy nobody thought about.
  const yml = read('customHttp.yml')
  if (!/script-src[^;]*'unsafe-inline'/.test(yml)) return
  assert.match(
    yml, /unsafe-inline|no build step|nonce/i,
    "script-src carries 'unsafe-inline' with no comment saying why. It is there because the " +
    'site has no build step to generate nonces; say so, so the next reader knows it is a ' +
    'decision rather than an oversight'
  )
})
