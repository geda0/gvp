// M8 item 3 (ADR-0021 D3). The chat store writes `ttl` (epoch seconds); DynamoDB only acts on
// it if the TABLE names that attribute. Derive the attribute from the writer rather than
// restating it, so the writer and the table cannot drift apart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('ChatTranscriptsTable enables TTL on the attribute transcript_store.py writes', () => {
  const store = read('docker/chat/app/transcript_store.py')
  const written = (store.match(/', (\w+) = :ttl'/) || [])[1]
  assert.ok(written, 'transcript_store.py no longer SETs a `<attr> = :ttl` — update this test with it')

  const tpl = read('aws/template.yaml')
  const table = tpl.split(/^  ChatTranscriptsTable:\s*$/m)[1]?.split(/^  [A-Za-z0-9]+:\s*$/m)[0] || ''
  assert.match(table, /TimeToLiveSpecification:\s*\n\s+AttributeName:\s*(\S+)\s*\n\s+Enabled:\s*true/)
  assert.equal(table.match(/TimeToLiveSpecification:\s*\n\s+AttributeName:\s*(\S+)/)[1], written)
})
