/**
 * Pure turn-epoch gate for the voice (Gemini Live) reply stream.
 *
 * `interrupted` cancels the current turn: everything the server still flushes for
 * that turn (audio AND transcript) must be dropped, not just the first fragment.
 * `turnComplete` is the turn boundary, so the gate re-opens there and the next turn
 * flows normally. The state is opaque and immutable; callers only ask
 * `acceptsTurnOutput`. Dependency-free (no DOM, AudioContext, or WebSocket).
 */
const OPEN = 'open'
const CANCELLED = 'cancelled'

export function freshTurnGate() {
  return OPEN
}

export function nextTurnGate(state, event) {
  if (event === 'interrupted') return CANCELLED
  if (event === 'turnComplete') return OPEN
  return state
}

export function acceptsTurnOutput(state) {
  return state !== CANCELLED
}
