import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLauncherIntent } from '../js/chat-launcher-intent.js'

// Regression: on subpages the launcher mic (#agentNodeMic) is docked INSIDE the chat
// input pill (#agentNode); tapping it wrongly opened the chat in VOICE mode. The fix
// routes a mic that lives inside #agentNode to TEXT mode instead.
test('routes a mic docked inside the launcher pill to text mode', () => {
  // Arrange: a fake button whose closest() matches the launcher pill selector.
  const button = {
    closest: (selector) => (selector === '#agentNode' ? { id: 'agentNode' } : null)
  }

  // Act
  const intent = resolveLauncherIntent({ button })

  // Assert: the in-pill mic launches text chat, not voice.
  assert.equal(intent, 'text')
})
