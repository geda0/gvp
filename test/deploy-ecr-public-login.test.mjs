// The chat stream image COPYs the Lambda Web Adapter from public.ecr.aws at build time.
// Anonymous pulls from ECR Public get the lowest rate limit, and on shared GitHub runners
// that limit is MEASURED hit: deploy-staging runs 38765137572 (2026-10-15) and 39939004822
// (2026-10-23) both died at `toomanyrequests: Data limit exceeded` before reaching the
// stream stack. An authenticated pull gets the higher limit, so while any Dockerfile pulls
// from public.ecr.aws, every deploy workflow must log in to it before the deploy step.
// The login is best-effort (`|| ...` fallback): without the IAM grant it degrades to the
// anonymous pull it replaces, never to a new failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const dockerfiles = readdirSync(new URL('../docker/chat/', import.meta.url)).filter((f) => f.startsWith('Dockerfile'))
const pullsPublicEcr = dockerfiles.some((f) => /public\.ecr\.aws\//.test(read(`docker/chat/${f}`)))

for (const wf of ['.github/workflows/deploy-staging.yml', '.github/workflows/deploy-prod.yml']) {
  test(`${wf} logs in to ECR Public before deploying, while a Dockerfile pulls from it`, { skip: !pullsPublicEcr }, () => {
    const text = read(wf)
    const login = text.search(/aws ecr-public get-login-password --region us-east-1[\s\S]*?docker login[^\n]*public\.ecr\.aws/)
    const deploy = text.search(/run: bash scripts\/integrate-and-deploy\.sh/)
    const creds = text.search(/configure-aws-credentials/)
    assert.ok(login > -1, 'no `aws ecr-public get-login-password --region us-east-1 | docker login ... public.ecr.aws` step')
    assert.ok(creds > -1 && login > creds, 'the login must come after the OIDC credentials step')
    assert.ok(deploy > login, 'the login must come before the deploy step')
    const step = text.slice(login, deploy)
    assert.match(step, /\|\|/, 'the login must be best-effort, so a missing IAM grant degrades to an anonymous pull')
  })
}
