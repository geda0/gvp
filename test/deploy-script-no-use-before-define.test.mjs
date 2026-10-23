import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Does a deploy script call one of its own functions before defining it?
//
// WHY THIS EXISTS — a real failure, MEASURED 2026-10-23.
// `scripts/integrate-and-deploy.sh` called `gvp_restore_operator_intent` at line 115 and
// defined it at line 138. In bash a function must exist at the moment the call RUNS, so the
// deploy died with `command not found` and exit 127 — after it had already written
// `.secrets/config.generated.env`, pushed a secret to Secrets Manager, and sourced the
// environment. It failed in the middle, having done side-effectful work.
//
// IT HAD BEEN BROKEN SINCE 2026-10-13 AND IS ON `main`. It only fires on the branch that
// runs the Secrets Manager prep (manifests present, `SKIP_SECRETS_MANAGER` unset), which is
// a local-operator path CI does not take — so neither the deploy workflow nor any test
// noticed for ten days, and the next person to deploy from a laptop hit it.
//
// WHY A WHOLE-CLASS CHECK AND NOT A ONE-LINE FIX. The fix is to move a function above its
// first use, which takes seconds and teaches nothing. The defect class — a shell script
// whose call order and definition order disagree — is invisible to every other test here
// (`node --check` does not run shell, and nothing executes these scripts in CI), silent
// until the exact branch that reaches it is taken, and it strands a half-finished deploy
// when it does. That is worth a referee.
//
// SCOPE, stated so a reader knows what this does NOT prove: it is a static scan for
// `name()`-style definitions and bare-word calls of those same names, so it cannot see
// dynamic dispatch, `eval`, or a function defined in a sourced file. It catches the shape
// that actually bit, which is a function defined lower in the same file than it is called.

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SCRIPTS = join(REPO, 'scripts')

/** Lines with executable content, stripped of comments and here-doc bodies. */
function codeLines (source) {
  const out = []
  let inHeredoc = null
  for (const [i, raw] of source.split('\n').entries()) {
    if (inHeredoc) {
      if (raw.trim() === inHeredoc) inHeredoc = null
      out.push({ n: i + 1, text: '' })
      continue
    }
    const heredoc = /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(raw)
    if (heredoc) inHeredoc = heredoc[1]
    const text = raw.replace(/#.*$/, '')
    out.push({ n: i + 1, text })
  }
  return out
}

function shellScripts () {
  return readdirSync(SCRIPTS, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sh'))
    .map((e) => e.name)
}

test('no deploy script calls one of its own functions before defining it', () => {
  const offenders = []

  for (const name of shellScripts()) {
    const lines = codeLines(readFileSync(join(SCRIPTS, name), 'utf8'))

    // `foo() {` or `function foo {` — the two shapes these scripts use.
    const definedAt = new Map()
    for (const { n, text } of lines) {
      const m = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/.exec(text)
        || /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(text)
      if (m && !definedAt.has(m[1])) definedAt.set(m[1], n)
    }
    if (!definedAt.size) continue

    for (const { n, text } of lines) {
      // A bare-word invocation: the name at the start of a command position. Deliberately
      // not matching `foo=`, `foo()`, or the name inside a string or a longer word.
      for (const [fn, defLine] of definedAt) {
        const called = new RegExp(`(^|[;&|]|\\b(?:then|else|do)\\s)\\s*${fn}\\b(?!\\s*\\(|\\s*=)`)
        if (!called.test(text)) continue
        if (n === defLine) continue
        if (n > defLine) continue
        offenders.push(
          `scripts/${name}: calls ${fn}() at line ${n}, but it is not defined until ${defLine}`
        )
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    'a shell function is called before it exists, so the script dies with `command not ' +
    'found` (exit 127) at that point — MID-DEPLOY, after the side-effectful work above it ' +
    'has already run:\n  ' + offenders.join('\n  ')
  )
})

test('the scan can actually see a use-before-define — positive control', () => {
  // Without this, a regex that matched nothing would make the row above pass forever. The
  // failure mode of a static scan is silence, so it has to be shown finding the thing.
  const lines = codeLines([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ -n "${X:-}" ]]; then',
    '  gvp_helper',
    'fi',
    'gvp_helper() {',
    '  echo hi',
    '}'
  ].join('\n'))

  const definedAt = new Map()
  for (const { n, text } of lines) {
    const m = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/.exec(text)
    if (m && !definedAt.has(m[1])) definedAt.set(m[1], n)
  }
  assert.equal(definedAt.get('gvp_helper'), 6, 'the definition scan must find the function')

  const callLine = lines.find(({ text }) => /(^|[;&|])\s*gvp_helper\b(?!\s*\(|\s*=)/.test(text))
  assert.ok(callLine, 'the call scan must find a bare-word invocation')
  assert.ok(callLine.n < 6, 'and must place it before the definition')
})
