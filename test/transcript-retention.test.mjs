// M8 item 3 (ADR-0021 D3). The chat store writes `ttl` (epoch seconds); DynamoDB only acts on
// it if the TABLE names that attribute. Derive the attribute from the writer rather than
// restating it, so the writer and the table cannot drift apart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('ChatTranscriptsTable enables TTL on the attribute transcript_store.py writes', () => {
  const store = read('docker/chat/app/transcript_store.py')
  // The writer SETs `#ttl = :ttl` (TTL is a DynamoDB reserved word) and names the real
  // attribute in ExpressionAttributeNames; that mapping is the attribute the table must name.
  assert.match(store, /', #ttl = :ttl'/, 'transcript_store.py no longer SETs `#ttl = :ttl`')
  const written = (store.match(/\{'#ttl': '(\w+)'\}/) || [])[1]
  assert.ok(written, 'no ExpressionAttributeNames mapping for #ttl in transcript_store.py')

  const tpl = read('aws/template.yaml')
  const table = tpl.split(/^  ChatTranscriptsTable:\s*$/m)[1]?.split(/^  [A-Za-z0-9]+:\s*$/m)[0] || ''
  assert.match(table, /TimeToLiveSpecification:\s*\n\s+AttributeName:\s*(\S+)\s*\n\s+Enabled:\s*true/)
  assert.equal(table.match(/TimeToLiveSpecification:\s*\n\s+AttributeName:\s*(\S+)/)[1], written)
})
