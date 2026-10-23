// ADR-0025 filed-forward #4: /api/chat/host-status compares against ADMIN_API_KEY on the chat
// host (docker/chat/app/main.py), but aws/chat-template.yaml never declared it, so the
// diagnostic was permanently 401 there - fail-closed, but dead. It is now a NoEcho parameter
// (default empty = still closed) wired into the function env, and the deploy script passes it
// only when set (a bare `Key=` fails the whole sam deploy).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('chat-template declares AdminApiKey (NoEcho, default empty) and wires it to ADMIN_API_KEY', () => {
  const t = read('aws/chat-template.yaml')
  assert.match(t, /^  AdminApiKey:\s*\n\s+Type:\s*String\s*\n\s+NoEcho:\s*true\s*\n\s+Default:\s*''/m)
  assert.match(t, /ADMIN_API_KEY:\s*!Ref AdminApiKey/)
})

test('the deploy script passes AdminApiKey to the chat stack only when ADMIN_API_KEY is set', () => {
  const s = read('scripts/integrate-and-deploy.sh')
  assert.match(s, /if \[\[ -n "\$\{ADMIN_API_KEY:-\}" \]\]; then\s*\n\s*CHAT_PO\+=\("AdminApiKey=\$\{ADMIN_API_KEY\}"\)/)
})
