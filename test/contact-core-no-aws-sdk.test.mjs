import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ADR-0005/0006 invariant guard: the contact `*-core.js` modules are the pure,
// dependency-injected composition cores that the always-present `node --test`
// floor exercises WITHOUT installing `aws/src/package.json`. They must therefore
// NEVER import `@aws-sdk/*`. The composition root (the Lambda entry files) may
// legitimately import the SDK — a fat-finger import into a core file must fail CI.
//
// Resolve `aws/src/` relative to THIS test file (not CWD) so the guard runs the
// same regardless of where `node --test` is invoked from.
const CORE_DIR = fileURLToPath(new URL('../aws/src/', import.meta.url))

// Match an ACTUAL module import of the SDK, not a bare substring a comment could
// trip: an ESM `from '@aws-sdk/...'` or a CJS `require('@aws-sdk/...')`.
const ESM_AWS_IMPORT = /from\s+['"]@aws-sdk/
const CJS_AWS_REQUIRE = /require\(\s*['"]@aws-sdk/

test('contact *-core.js modules import no @aws-sdk', () => {
  const coreFiles = readdirSync(CORE_DIR).filter((name) => name.endsWith('-core.js'))

  // The guard must not silently pass on zero files — there has to be at least one
  // core module for "none of them import the SDK" to mean anything.
  assert.ok(
    coreFiles.length > 0,
    `expected at least one *-core.js module in aws/src/, found none — guard would be vacuous`
  )

  for (const name of coreFiles) {
    const source = readFileSync(new URL(`../aws/src/${name}`, import.meta.url), 'utf8')

    assert.ok(
      !ESM_AWS_IMPORT.test(source),
      `${name} must NOT import @aws-sdk/* (ESM import found) — core modules stay install-free per ADR-0005/0006`
    )
    assert.ok(
      !CJS_AWS_REQUIRE.test(source),
      `${name} must NOT require @aws-sdk/* (CJS require found) — core modules stay install-free per ADR-0005/0006`
    )
  }
})
