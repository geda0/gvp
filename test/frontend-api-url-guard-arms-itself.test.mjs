import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const GUARD = 'test/frontend-api-url-env-guard.test.mjs'

// The host-leak guard has never actually run on Amplify. It fails OPEN.
//
// `amplify.yml`'s preBuild says it "fails the build (non-zero exit) whenever the committed
// HTML hosts don't match the app's environment", and its comment names the 2026-06-04
// incident it exists to prevent — a fast-forward that published STAGING backends to
// production. It runs:
//
//     GVP_EXPECTED_ENV=$GVP_EXPECTED_ENV node --test test/frontend-api-url-env-guard.test.mjs
//
// MEASURED 2026-10-14: `GVP_EXPECTED_ENV` is **unset on every Amplify app and every branch**
// (`gvp`/`diswkpz9dn24t` and `home`/`d2ey3rf8zwq2lv`, branches agent and main). With it unset
// the guard resolves no environment and SKIPS — 0 pass, 0 fail, 1 skip — so the build goes
// green regardless of which hosts are committed. The prod-promotion runbook has carried "set
// GVP_EXPECTED_ENV on the Amplify app" as an open owner action since June; until it is done
// the guard is decoration.
//
// It was not hypothetical either. Merging `main` into `agent` on 2026-10-14 to sync a README
// carried main's PROD hosts onto the staging branch, so staging served the production contact
// API and the production chat host. Three consecutive Amplify stage builds (jobs 193/194/195)
// reported SUCCEED. The guard that exists for precisely this caught nothing.
//
// A guard whose arming depends on a manually-set variable will be unarmed exactly when it
// matters. Amplify already publishes the branch as `AWS_BRANCH`, so the guard can arm itself
// from the build it is running inside — no console configuration, nothing to forget.
//
// This test drives the real guard as a subprocess under a simulated Amplify environment,
// rather than re-implementing the resolver, so it cannot drift from the thing it describes.

const runGuard = (env) => {
  try {
    const out = execFileSync(
      process.execPath,
      ['--test', GUARD],
      {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // A bare env: inheriting the parent would leak this run's own GITHUB_REF_NAME
        // or GVP_EXPECTED_ENV and make the probe lie.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }
      }
    )
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const summarize = (out) => ({
  skipped: /# skipped 1/.test(out),
  pass: Number((out.match(/# pass (\d+)/) || [, '0'])[1]),
  fail: Number((out.match(/# fail (\d+)/) || [, '0'])[1])
})

test('the guard arms itself from AWS_BRANCH, with no console variable to forget', () => {
  // Exactly what Amplify provides for the staging app: the branch, and nothing else.
  const r = runGuard({ AWS_BRANCH: 'agent' })
  const s = summarize(r.out)

  assert.equal(
    s.skipped, false,
    'with AWS_BRANCH=agent the guard still SKIPS, so it is inert on Amplify — the build goes ' +
    'green no matter which hosts are committed. It must resolve "stage" from the branch ' +
    `Amplify is building. Output:\n${r.out}`
  )
  assert.ok(s.pass > 0, `the guard must actually assert something. Output:\n${r.out}`)
})

test('AWS_BRANCH=main resolves prod, so the production app is covered too', () => {
  const r = runGuard({ AWS_BRANCH: 'main' })
  const s = summarize(r.out)

  // Only ARMING is under test here, not the verdict. Which verdict is correct depends on the
  // branch this suite happens to run from: checked out on `agent` the tree carries STAGE
  // hosts, so asking for prod SHOULD fail; on `main` it should pass. Asserting pass > 0 would
  // make this test's result depend on the checkout, which is how a guard test starts lying.
  assert.equal(
    s.skipped, false,
    `AWS_BRANCH=main must resolve prod and run the assertions, not skip. Output:\n${r.out}`
  )
  assert.ok(
    s.pass + s.fail > 0,
    `the guard must actually evaluate the hosts under AWS_BRANCH=main. Output:\n${r.out}`
  )
})

test('an explicit GVP_EXPECTED_ENV still wins over the branch', () => {
  // The deploy workflows set it deliberately; branch inference must not override that.
  const r = runGuard({ AWS_BRANCH: 'agent', GVP_EXPECTED_ENV: 'prod' })
  const s = summarize(r.out)
  assert.equal(s.skipped, false, 'an explicit value must still arm the guard')
  // On the agent branch the working tree carries STAGE hosts, so asking for prod must FAIL.
  // That is the assertion that proves precedence: if the branch won, this would pass.
  assert.ok(
    s.fail > 0,
    'GVP_EXPECTED_ENV=prod on a stage-hosts tree must FAIL. It passed, which means branch ' +
    `inference overrode the explicit value — wrong precedence. Output:\n${r.out}`
  )
})

test('an unrelated branch still skips, so feature branches are not blocked', () => {
  const r = runGuard({ AWS_BRANCH: 'claude/some-feature' })
  assert.equal(
    summarize(r.out).skipped, true,
    'a non-deploy branch must still skip — otherwise every feature branch build fails on ' +
    `hosts it was never meant to pin. Output:\n${r.out}`
  )
})

test('amplify.yml passes the branch through, not only the manual variable', () => {
  const yml = readFileSync(join(REPO, 'amplify.yml'), 'utf8')
  assert.match(
    yml, /frontend-api-url-env-guard/,
    'amplify.yml must still run the guard in preBuild'
  )
  // The command may keep forwarding GVP_EXPECTED_ENV, but it must not be the ONLY way the
  // guard can arm — AWS_BRANCH is already in the build environment and needs no plumbing.
  assert.doesNotMatch(
    yml, /GVP_EXPECTED_ENV=\$GVP_EXPECTED_ENV\s+node\s+--test\s+test\/frontend-api-url-env-guard\.test\.mjs\s*$/m,
    'the preBuild line still arms the guard ONLY from GVP_EXPECTED_ENV, which is unset on ' +
    'every app — document the AWS_BRANCH fallback in that command so the next reader knows ' +
    'the guard is self-arming and does not "fix" it back to a manual variable'
  )
})
