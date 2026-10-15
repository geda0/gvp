import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const script = readFileSync(join(REPO, 'scripts/integrate-and-deploy.sh'), 'utf8')

// `sam deploy` rejects a bare `Key=` outright, so every OPTIONAL parameter must be omitted
// when empty rather than passed empty.
//
//   Error: Invalid value for '--parameter-overrides': GeminiApiKeySecretArn= is not a valid
//   format. … exit 2
//
// That is a real CI failure from 2026-10-15, and it is the SECOND time the same mistake
// shipped in the same block: `GeminiApiKey` was guarded and `GeminiApiKeySecretArn` was left
// unconditional two commits later. `sam_param_override` does not help — it emits `Key=` for
// an empty value, it does not omit.
//
// The trap is asymmetric and that is why it keeps recurring: locally these variables come
// from .secrets/* and are usually non-empty, so the bare form never fires. In CI they are
// unset, so the deploy dies at the last step after a full container build. The feedback is
// slow and far from the cause.
//
// This pins the pattern rather than the individual parameters, so a third optional secret
// cannot be added unguarded.

// Parameters that are legitimately optional: unset in CI, unset in .secrets, or
// deliberately omitted so a secret can REPLACE an env var (ADR-0025).
const OPTIONAL = [
  'GeminiApiKey',
  'GeminiApiKeySecretArn',
  'SmokeProbeKey',
  'IpHashPepper'
]

// ONLY the arrays consumed by `sam deploy`. `CHAT_EX_PO` goes through
// `aws cloudformation deploy`, which ACCEPTS a bare `Key=` — the script records that
// asymmetry as measured, and it is the whole reason this is easy to get wrong. Asserting
// against the express array too would be a false positive that forces a pointless guard.
const SAM_ARRAYS = /^\s*(PO|CHAT_PO|CHAT_STREAM_PO)(\+)?=\(?/

for (const param of OPTIONAL) {
  test(`${param} is never passed to sam deploy when empty`, () => {
    // Find every line that puts this parameter into a SAM overrides array. Array literals
    // span lines, so track which array we are inside.
    const lines = script.split('\n')
    let inSam = false
    const uses = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (SAM_ARRAYS.test(l)) inSam = true
      else if (/^\s*CHAT_EX_PO(\+)?=\(?|^\s*CDN_PO(\+)?=\(?/.test(l)) inSam = false
      else if (/^\s*\)\s*$/.test(l)) inSam = false
      const hit = new RegExp(`(sam_param_override\\s+${param}\\b|"${param}=)`).test(l)
      if (hit && (inSam || SAM_ARRAYS.test(l))) uses.push([i + 1, l])
    }

    assert.ok(uses.length > 0, `${param} is not passed anywhere — update this list if it was removed`)

    for (const [lineNo, line] of uses) {
      // It must sit inside an `if [[ -n … ]]` guard, which in this script always means the
      // use is a `+=` append rather than a bare array element.
      assert.match(
        line, /\+=\(/,
        `scripts/integrate-and-deploy.sh:${lineNo} passes ${param} as a plain array element:\n` +
        `    ${line.trim()}\n` +
        'An empty value then reaches sam deploy as a bare `' + param + '=`, which it rejects ' +
        'with exit 2 after the whole container build. Append it conditionally instead:\n' +
        `    if [[ -n "\${VAR:-}" ]]; then ARRAY+=("$(sam_param_override ${param} "\${VAR}")"); fi`
      )
    }
  })
}
