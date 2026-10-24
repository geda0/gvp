/**
 * Pure turn-epoch gate for the voice (Gemini Live) reply stream.
 *
 * `interrupted` cancels the current turn: everything the server still flushes for
 * that turn (audio AND transcript) must be dropped, not just the first fragment.
 * `turnComplete` is the turn boundary, so the gate re-opens there and the next turn
 * flows normally. The state is opaque and immutable; callers only ask
 * `acceptsTurnOutput`. Dependency-free (no DOM, AudioContext, or WebSocket).
 *
 * ADR-0026 §3.2: the open gate splits in two. `idle` = no server turn in flight;
 * `streaming` = one is (a clientContent turn was sent, or model output arrived). A LOCAL
 * interrupt (chip, text turn, mic tap) cancels only `streaming` — on `idle` it leaves the
 * gate open, or the reply to the very act that cut the assistant off would be dropped.
 *
 *   state \ event   turnStarted  localInterrupt  interrupted  turnComplete
 *   idle            streaming    idle            cancelled    idle
 *   streaming       streaming    cancelled       cancelled    idle
 *   cancelled       cancelled    cancelled       cancelled    idle
 */
const IDLE = 'idle'
const STREAMING = 'streaming'
const CANCELLED = 'cancelled'

export function freshTurnGate() {
  return IDLE
}

export function nextTurnGate(state, event) {
  if (event === 'turnComplete') return IDLE
  if (event === 'interrupted') return CANCELLED
  if (event === 'localInterrupt') return state === STREAMING ? CANCELLED : state
  if (event === 'turnStarted') return state === IDLE ? STREAMING : state
  return state
}

export function acceptsTurnOutput(state) {
  return state !== CANCELLED
}
