// ADR-0026 §6: the stream image's base layers are pinned by digest. A floating tag
// (`python:3.12-slim`) re-resolves on every build, so a routine deploy can ship brand-new base
// layers that the first cold start then has to pull lazily — the 9–10 s post-deploy cold start
// in the RCA. The tag stays beside the digest for humans; the digest is what resolves.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const DOCKERFILE = 'docker/chat/Dockerfile.lambda-stream'
const text = readFileSync(new URL(`../${DOCKERFILE}`, import.meta.url), 'utf8')

// Every image reference: `FROM <ref> [AS name]` and `COPY --from=<ref> ...`. Line
// continuations are joined first so a wrapped instruction cannot hide a reference.
export function imageRefs (dockerfile) {
  const lines = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
  const refs = []
  const stages = new Set()
  for (const raw of lines) {
    const line = raw.trim()
    const from = line.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i)
    if (from) {
      refs.push(from[1])
      if (from[2]) stages.add(from[2].toLowerCase())
      continue
    }
    const copy = line.match(/^COPY\s+(?:--\S+\s+)*?--from=(\S+)/i)
    // `COPY --from=<build-stage>` names a stage of THIS file, not an image.
    if (copy && !stages.has(copy[1].toLowerCase())) refs.push(copy[1])
  }
  return refs
}

const PINNED = /^[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}$/

test('imageRefs finds FROM and COPY --from= references and skips build stages', () => {
  const refs = imageRefs('FROM a:1 AS build\nFROM b:2\nCOPY --from=build /x /y\nCOPY --chown=1 --from=c:3 /p /q\n')
  assert.deepEqual(refs, ['a:1', 'b:2', 'c:3'])
})

test(`${DOCKERFILE} has at least one FROM and one COPY --from= image`, () => {
  const refs = imageRefs(text)
  assert.ok(refs.length >= 2, `expected the base image and the Lambda Web Adapter, got ${JSON.stringify(refs)}`)
})

test(`every image in ${DOCKERFILE} is pinned as <name>:<tag>@sha256:<64 hex>`, () => {
  const unpinned = imageRefs(text).filter((ref) => !PINNED.test(ref))
  assert.deepEqual(unpinned, [], `floating image references (ADR-0026 §6): ${unpinned.join(', ')}`)
})

test(`${DOCKERFILE} says how to bump the pinned digests`, () => {
  assert.match(text, /docker buildx imagetools inspect/, 'missing the bump instructions (ADR-0026 §6)')
})
