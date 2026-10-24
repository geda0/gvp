import test from 'node:test'
import assert from 'node:assert/strict'

import { bootChatWithLiveVoice } from './fixtures/chat-harness.mjs'

// L2 (ADR-0026 §5.3), WIRED: test/chat-prewarm.test.mjs pins the module; this file asks
// whether the real js/chat.js calls it on the first chat-open intent — launcher hover,
// launcher focus, or the panel opening — and only once per page load. A prewarm with no
// caller is the starfield depth-fade bug again (test/starfield-depth-wiring.test.mjs).

// crypto.subtle.digest settles on the thread pool, not on the next tick: give it real time.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const warms = (fetchCalls) => fetchCalls.filter((c) => c.url.endsWith('/api/chat') && c.opts?.body === '{"warm":true}')

const INTENTS = {
  'launcher hover': ({ getEl }) => getEl('agentNode').dispatchEvent({ type: 'pointerenter' }),
  'launcher focus': ({ getEl }) => getEl('agentNode').querySelector('.agent-node__input').dispatchEvent({ type: 'focus' }),
  'chat open': ({ api }) => api.openPanel()
}

for (const [first, fire] of Object.entries(INTENTS)) {
  test(`the first chat intent (${first}) sends one warm, and no later intent sends another`, async (t) => {
    // Arrange — the page between load and the first interaction.
    const h = await bootChatWithLiveVoice({ tag: `prewarm-${first.replace(/\s/g, '-')}`, voice: false })
    t.after(() => h.api.disposeChatLiveVoice())
    await settle()
    const atLoad = warms(h.fetchCalls).length

    // Act — the first intent, then every intent again (re-hover, re-focus, re-open).
    fire(h)
    await settle()
    const afterFirst = warms(h.fetchCalls).length
    for (const again of Object.values(INTENTS)) { again(h); await settle() }
    h.api.closePanelImmediate()
    h.api.openPanel()
    await settle()

    // Assert
    assert.deepEqual(
      { atLoad, afterFirst, total: warms(h.fetchCalls).length },
      { atLoad: 0, afterFirst: 1, total: 1 },
      'one warm per page load, on the first chat-open intent (ADR-0026 §5.3) — never at load, ' +
      'never again on a re-open'
    )
  })
}
